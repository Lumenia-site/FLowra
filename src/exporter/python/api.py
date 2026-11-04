import json
import math
import mimetypes
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


class TelegramError(Exception):
    def __init__(self, code, description, retry_after=0):
        self.code = code
        self.retry_after = retry_after
        super().__init__(f'Telegram {code}: {description}')


class Telegram:
    def __init__(self, token, root, stop_event=None):
        self.token = token
        self.root = Path(root).resolve()
        self.last_request = 0
        self.chat_requests = {}
        self.stop_event = stop_event or threading.Event()
        self.pacing_lock = threading.Lock()

    def wait(self, seconds):
        if self.stop_event.wait(max(0, seconds)):
            raise InterruptedError('Бот остановлен.')

    def _file(self, relative, field='document'):
        path = (self.root / relative).resolve()
        if not str(relative).startswith('assets/') or self.root not in path.parents or not path.is_file():
            raise ValueError(f'Медиафайл недоступен: {relative}')
        extensions = {'photo': ['.jpg', '.jpeg', '.png', '.webp'], 'video': ['.mp4', '.mov', '.m4v'], 'audio': ['.mp3', '.m4a'], 'voice': ['.ogg', '.oga', '.mp3', '.m4a']}.get(field, [])
        if extensions and path.suffix.lower() not in extensions:
            raise ValueError(f'Неподходящий формат медиа: {path.name}')
        maximum = (10 if field == 'photo' else 50) * 1024 * 1024
        if not 0 < path.stat().st_size <= maximum:
            raise ValueError(f'Файл пуст или превышает {maximum // 1024 // 1024} МБ: {path.name}')
        return path

    def _multipart(self, payload, files):
        boundary = uuid.uuid4().hex
        chunks = []
        for key, value in payload.items():
            if value is None:
                continue
            content = json.dumps(value, ensure_ascii=False) if isinstance(value, (dict, list, bool)) else str(value)
            chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{content}\r\n'.encode())
        for key, path in files.items():
            mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
            chunks.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"; filename="{path.name}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
            chunks.extend([path.read_bytes(), b'\r\n'])
        chunks.append(f'--{boundary}--\r\n'.encode())
        return b''.join(chunks), f'multipart/form-data; boundary={boundary}'

    def call(self, method, payload=None):
        payload = dict(payload or {})
        files = {}
        for field in ['photo', 'video', 'audio', 'voice', 'document']:
            value = payload.get(field)
            if isinstance(value, str) and value.startswith('assets/'):
                files[field] = self._file(value, field)
                del payload[field]
            elif isinstance(value, str) and (Path(value).is_absolute() or re.match(r'^[A-Za-z]:[\\/]', value) or value.startswith('../')):
                raise ValueError('Абсолютные пути не поддерживаются. Добавьте файл в assets проекта.')
        if isinstance(payload.get('media'), list):
            media = []
            for index, item in enumerate(payload['media']):
                item = dict(item)
                value = item.get('media')
                if isinstance(value, str) and value.startswith('assets/'):
                    key = f'file{index}'
                    files[key] = self._file(value, item.get('type', 'document'))
                    item['media'] = f'attach://{key}'
                elif isinstance(value, str) and (Path(value).is_absolute() or re.match(r'^[A-Za-z]:[\\/]', value)):
                    raise ValueError('Альбом содержит абсолютный путь к файлу.')
                media.append(item)
            payload['media'] = media
        if files:
            body, content_type = self._multipart(payload, files)
        else:
            body = json.dumps(payload, ensure_ascii=False).encode()
            content_type = 'application/json'
        for attempt in range(6):
            if self.stop_event.is_set():
                raise InterruptedError('Бот остановлен.')
            if method.startswith('send') or method.startswith('edit') or method.startswith('deleteMessage'):
                chat_id = str(payload.get('chat_id', ''))
                with self.pacing_lock:
                    now = time.monotonic()
                    scheduled = max(now, self.last_request, self.chat_requests.get(chat_id, 0))
                    self.last_request = scheduled + 0.06
                    self.chat_requests[chat_id] = scheduled + 1.05
                    if len(self.chat_requests) > 10000:
                        self.chat_requests = {key: value for key, value in self.chat_requests.items() if value > now}
                self.wait(scheduled - now)
            request = urllib.request.Request(f'https://api.telegram.org/bot{self.token}/{method}', data=body, headers={'Content-Type': content_type})
            try:
                with urllib.request.urlopen(request, timeout=65) as response:
                    result = json.load(response)
            except urllib.error.HTTPError as error:
                try:
                    result = json.loads(error.read())
                except (ValueError, UnicodeDecodeError):
                    raise TelegramError(error.code, 'Сервис вернул некорректный ответ.') from None
            except (urllib.error.URLError, TimeoutError, OSError):
                raise RuntimeError('Нет соединения с Telegram. Проверьте доступ к api.telegram.org.') from None
            if result.get('ok'):
                return result.get('result')
            code = result.get('error_code', 0)
            retry = result.get('parameters', {}).get('retry_after', 1)
            if (code == 429 or code >= 500) and attempt < 5:
                self.wait(max(1, min(float(retry), 3600)) if code == 429 else 0.5 * 2 ** attempt)
                continue
            description = str(result.get('description', 'Неизвестная ошибка')).replace(self.token, '[скрыто]')
            raise TelegramError(code, description, retry)

    def send_node(self, kind, data, chat_id):
        payload = {'chat_id': chat_id}
        parse_mode = data.get('parseMode')
        if parse_mode:
            payload['parse_mode'] = parse_mode
        if kind == 'sendMessage':
            payload['text'] = str(data.get('text', ''))
            if not payload['text'].strip():
                raise ValueError('Сообщение не должно быть пустым.')
        elif kind in ['sendPhoto', 'sendVideo', 'sendAudio', 'sendVoice', 'sendDocument']:
            field = kind[4:].lower()
            payload[field] = data.get('media') or data.get('file') or data.get('url') or ''
            if not payload[field]:
                raise ValueError('Выберите файл, укажите URL или Telegram file_id.')
            if str(payload[field]).startswith('http'):
                validate_url(str(payload[field]))
            payload['caption'] = data.get('caption', '')
        elif kind == 'sendLocation':
            payload.update(latitude=float(data.get('latitude', 0)), longitude=float(data.get('longitude', 0)))
            if not math.isfinite(payload['latitude']) or not -90 <= payload['latitude'] <= 90 or not math.isfinite(payload['longitude']) or not -180 <= payload['longitude'] <= 180:
                raise ValueError('Некорректные координаты геопозиции.')
            payload.pop('parse_mode', None)
        elif kind == 'sendContact':
            payload.update(phone_number=str(data.get('phoneNumber', '')), first_name=str(data.get('firstName', '')), last_name=str(data.get('lastName', '')))
            if not payload['phone_number'] or not payload['first_name']:
                raise ValueError('Укажите номер телефона и имя контакта.')
            payload.pop('parse_mode', None)
        elif kind in ['sendPoll', 'sendQuiz']:
            answers = data.get('answers') or data.get('options') or []
            if not str(data.get('question', '')).strip() or not isinstance(answers, list) or not 2 <= len(answers) <= 12 or any(not str(answer.get('text', '') if isinstance(answer, dict) else answer).strip() for answer in answers):
                raise ValueError('В опросе должно быть от 2 до 12 ответов.')
            payload.update(question=str(data.get('question', '')), options=[{'text': str(answer.get('text', '') if isinstance(answer, dict) else answer)} for answer in answers], is_anonymous=data.get('anonymous') is not False)
            payload.pop('parse_mode', None)
            if kind == 'sendQuiz':
                correct = int(data.get('correctAnswer', 0))
                if not 0 <= correct < len(answers):
                    raise ValueError('Номер правильного ответа вне списка.')
                payload.update(type='quiz', correct_option_ids=[correct], explanation=str(data.get('explanation', '')), allows_multiple_answers=False)
            else:
                payload.update(type='regular', allows_multiple_answers=bool(data.get('multiple', data.get('multipleAnswers', False))))
            kind = 'sendPoll'
        elif kind == 'sendMediaGroup':
            items = data.get('items') or data.get('media') or []
            if not isinstance(items, list) or not 2 <= len(items) <= 10:
                raise ValueError('В альбоме должно быть от 2 до 10 файлов.')
            payload['media'] = []
            for item in items:
                if item.get('type') not in ['photo', 'video'] or not item.get('media'):
                    raise ValueError('Альбом поддерживает фото и видео.')
                if str(item['media']).startswith('http'):
                    validate_url(str(item['media']))
                media = {'type': item['type'], 'media': item.get('media', ''), 'caption': item.get('caption', '')}
                if parse_mode:
                    media['parse_mode'] = parse_mode
                payload['media'].append(media)
            payload.pop('parse_mode', None)
        elif kind in ['editMessage', 'deleteMessage']:
            payload['message_id'] = int(data.get('messageId', 0))
            if payload['message_id'] <= 0:
                raise ValueError('Для изменения или удаления нужен ID сообщения.')
            if kind == 'editMessage':
                payload['text'] = str(data.get('text', ''))
                kind = 'editMessageText'
            else:
                payload.pop('parse_mode', None)
        elif kind in ['inlineKeyboard', 'replyKeyboard', 'urlButton']:
            payload['text'] = str(data.get('text') or 'Выберите действие')
            rows = data.get('rows') or []
            if not isinstance(rows, list):
                raise ValueError('Клавиатура должна содержать строки кнопок.')
            if kind == 'urlButton':
                rows = [[{'text': data.get('buttonText') or data.get('label') or 'Открыть', 'action': 'url', 'value': data.get('url', '')}]]
            keyboard = []
            for row in rows:
                if isinstance(row, dict):
                    row = row.get('buttons')
                if not isinstance(row, list) or not row:
                    raise ValueError('Строка клавиатуры пуста.')
                buttons = []
                for button in row:
                    item = {'text': str(button.get('text', 'Кнопка'))}
                    if not item['text'].strip():
                        raise ValueError('У кнопки должен быть текст.')
                    action = button.get('action', 'callback')
                    value = str(button.get('value', ''))
                    if kind == 'replyKeyboard':
                        if action in ['contact', 'request_contact']:
                            item['request_contact'] = True
                        elif action in ['location', 'request_location']:
                            item['request_location'] = True
                    elif action == 'url':
                        validate_url(value)
                        item['url'] = value
                    else:
                        item['callback_data'] = '__flowra:' + value if action in ['node', 'goto'] else value
                        if not 1 <= len(item['callback_data'].encode()) <= 64:
                            raise ValueError('Данные callback-кнопки должны занимать от 1 до 64 байт.')
                    buttons.append(item)
                if buttons:
                    keyboard.append(buttons)
            if not keyboard:
                raise ValueError('Добавьте хотя бы одну кнопку.')
            payload['reply_markup'] = {'keyboard': keyboard, 'resize_keyboard': True, 'one_time_keyboard': bool(data.get('oneTime', False))} if kind == 'replyKeyboard' else {'inline_keyboard': keyboard}
            kind = 'sendMessage'
        else:
            raise ValueError(f'Неподдерживаемый Telegram-блок: {kind}')
        return self.call(kind, payload)


def validate_url(value):
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in ['http', 'https'] or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError('Разрешены только HTTP и HTTPS без пароля в адресе.')
    return parsed
