import json
import math
import random
import re
import threading
import urllib.error
import urllib.parse
import urllib.request


def lookup(context, path):
    value = context
    for part in str(path).replace('{{', '').replace('}}', '').strip().removeprefix('variable.').split('.'):
        if part in ['__proto__', 'constructor', 'prototype']:
            return None
        if isinstance(value, dict):
            value = value.get(part)
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            return None
    return value


def as_text(value):
    if value is None:
        return ''
    if isinstance(value, (dict, list, bool)):
        return json.dumps(value, ensure_ascii=False, separators=(',', ':'))
    return str(value)


def render(value, context):
    if isinstance(value, str):
        return re.sub(r'\{\{\s*([^{}]+?)\s*\}\}', lambda match: as_text(lookup(context, match.group(1))), value)
    if isinstance(value, list):
        return [render(item, context) for item in value]
    if isinstance(value, dict):
        return {key: render(item, context) for key, item in value.items() if key not in ['__proto__', 'constructor', 'prototype']}
    return value


def compare(left, operator, right):
    operator = str(operator).lower().replace('_', ' ')
    operator = {'!=': 'not equals', 'neq': 'not equals', 'not equal': 'not equals', '>': 'greater', 'gt': 'greater', '<': 'less', 'lt': 'less', '>=': 'greater or equal', 'gte': 'greater or equal', '<=': 'less or equal', 'lte': 'less or equal'}.get(operator, operator)
    if operator == 'exists':
        return left is not None and left != ''
    if operator in ['equals', 'not equals']:
        equal = as_text(left) == as_text(right)
        return equal if operator == 'equals' else not equal
    if operator == 'contains':
        return as_text(right) in as_text(left)
    try:
        left, right = float(left), float(right)
    except (ValueError, TypeError):
        return False
    if not math.isfinite(left) or not math.isfinite(right):
        return False
    return {'greater': left > right, 'less': left < right, 'greater or equal': left >= right, 'less or equal': left <= right}.get(operator, False)


def parse_value(value):
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


class Engine:
    def __init__(self, workflow, telegram, store, stop_event=None):
        self.workflow = workflow
        self.telegram = telegram
        self.store = store
        self.nodes = {node['id']: node for node in workflow['nodes']}
        self.stop_event = stop_event or threading.Event()

    def outgoing(self, node_id, handle=None):
        edges = [edge for edge in self.workflow['edges'] if edge['source'] == node_id]
        return [edge['target'] for edge in edges if handle is None or str(edge.get('sourceHandle', '')) == str(handle)]

    def process_update(self, update):
        callback = update.get('callback_query')
        message = callback.get('message', {}) if callback else update.get('message', {})
        profile = callback.get('from') if callback else message.get('from')
        chat_id = message.get('chat', {}).get('id') or (callback.get('from', {}).get('id') if callback else None)
        if not profile or chat_id is None:
            return
        user = self.store.upsert_user(profile, chat_id)
        user_id = user['id']
        variables = self.store.variables(user_id)
        context = dict(variables)
        context.update(variable=dict(variables), user=profile, chat=message.get('chat') or {'id': chat_id}, message=message, callback=callback or {}, last_message_id=message.get('message_id') if callback else variables.get('_last_message_id'))
        text = str(message.get('text', ''))
        command = re.split(r'\s', text)[0].split('@')[0].lower()
        if callback:
            self.telegram.call('answerCallbackQuery', {'callback_query_id': callback['id']})
            callback_data = str(callback.get('data', ''))
            if callback_data.startswith('__flowra:'):
                target = callback_data[9:]
                if target not in self.nodes:
                    raise ValueError('Кнопка ссылается на удалённый блок. Обновите сценарий.')
                self.store.set_current_node(user_id, None)
                self.execute([target], user_id, chat_id, context)
                return
            triggers = [node['id'] for node in self.workflow['nodes'] if node['type'] == 'callback' and str(node.get('data', {}).get('callbackData', node.get('data', {}).get('data', node.get('data', {}).get('value', '')))) == callback_data]
            if triggers:
                self.store.set_current_node(user_id, None)
            self.execute(triggers, user_id, chat_id, context)
            return
        commands = [node['id'] for node in self.workflow['nodes'] if (node['type'] == 'start' and command == '/start') or (node['type'] == 'command' and command == str(node.get('data', {}).get('command', '')).split('@')[0].lower())]
        if commands:
            self.store.set_current_node(user_id, None)
            self.execute(commands, user_id, chat_id, context)
            return
        waiting = self.store.current_node(user_id)
        queue = []
        resumed = False
        if waiting and waiting in self.nodes and self.nodes[waiting]['type'] == 'input':
            node = self.nodes[waiting]
            data = node.get('data', {})
            input_type = data.get('inputType', 'text')
            value = None
            valid = True
            if input_type == 'contact':
                value = message.get('contact')
                valid = value is not None
            elif input_type == 'location':
                value = message.get('location')
                valid = value is not None
                if valid:
                    value = {'latitude': value.get('latitude'), 'longitude': value.get('longitude')}
            elif input_type == 'number':
                try:
                    value = float(text.replace(',', '.'))
                    valid = math.isfinite(value)
                    if valid and value.is_integer():
                        value = int(value)
                except ValueError:
                    valid = False
            else:
                value = message.get('text')
                valid = value is not None
            if not valid:
                self.telegram.call('sendMessage', {'chat_id': chat_id, 'text': {'number': 'Отправьте число.', 'contact': 'Отправьте контакт.', 'location': 'Отправьте геопозицию.'}.get(input_type, 'Отправьте текстовое сообщение.')})
                return
            key = str(data.get('variable') or data.get('name') or 'answer')
            self.save_variable(user_id, key, value, context)
            self.store.set_current_node(user_id, None)
            queue = self.outgoing(waiting)
            resumed = True
        if not resumed:
            if waiting:
                self.store.set_current_node(user_id, None)
            queue = [node['id'] for node in self.workflow['nodes'] if node['type'] == 'message' and (not node.get('data', {}).get('text') or str(node['data']['text']) in text)]
        self.execute(queue, user_id, chat_id, context)

    def save_variable(self, user_id, key, value, context):
        key = key.removeprefix('variable.')
        if not key or len(key) > 128 or key in ['user', 'chat', 'message', 'callback', 'variable', 'last_message_id', '__proto__', 'constructor', 'prototype']:
            raise ValueError('Укажите имя переменной, отличное от встроенных имён.')
        self.store.set_variable(user_id, key, value)
        context[key] = value
        context['variable'][key] = value

    def execute(self, queue, user_id, chat_id, context):
        steps = 0
        while queue:
            if self.stop_event.is_set():
                raise InterruptedError('Бот остановлен.')
            steps += 1
            if steps > 500:
                raise ValueError('Превышено 500 шагов сценария. Проверьте циклические связи.')
            node_id = queue.pop(0)
            node = self.nodes.get(node_id)
            if not node:
                continue
            kind = node['type']
            raw = node.get('data', {})
            data = render(raw, context)
            next_nodes = self.outgoing(node_id)
            label = str(raw.get('label') or kind)
            token = getattr(self.telegram, 'token', '')
            print(f'Блок: {label.replace(token, "[скрыто]") if token else label}', flush=True)
            if kind in ['start', 'command', 'message', 'callback']:
                pass
            elif kind == 'input':
                if data.get('prompt'):
                    self.telegram.call('sendMessage', {'chat_id': chat_id, 'text': data['prompt']})
                self.store.set_current_node(user_id, node_id)
                return
            elif kind in ['variable', 'setVariable']:
                self.save_variable(user_id, str(data.get('variable') or data.get('name') or ''), parse_value(data.get('value', '')), context)
            elif kind == 'getVariable':
                name = str(data.get('variable') or data.get('name') or '').removeprefix('variable.')
                value = lookup(context, name)
                target = str(data.get('target') or name).removeprefix('variable.')
                if target != name:
                    self.save_variable(user_id, target, value, context)
            elif kind == 'condition':
                left = lookup(context, raw.get('variable', ''))
                handle = 'true' if compare(left, data.get('operator', 'equals'), data.get('value', '')) else 'false'
                next_nodes = self.outgoing(node_id, handle)
            elif kind == 'switch':
                left = lookup(context, raw.get('variable', ''))
                handles = ['default', 'else']
                for index, case in enumerate(data.get('cases', [])):
                    if compare(left, 'equals', case.get('value', '')):
                        handles = [str(case.get('handle') or case.get('label') or index)]
                        break
                next_nodes = [edge['target'] for edge in self.workflow['edges'] if edge['source'] == node_id and str(edge.get('sourceHandle')) in handles]
            elif kind == 'random':
                next_nodes = [random.choice(next_nodes)] if next_nodes else []
            elif kind == 'delay':
                seconds = float(data.get('seconds', 1))
                if not math.isfinite(seconds) or not 0 <= seconds <= 86400:
                    raise ValueError('Задержка должна быть от 0 до 86400 секунд.')
                if self.stop_event.wait(seconds):
                    raise InterruptedError('Бот остановлен.')
            elif kind == 'http':
                result, status = self.http_request(data, include_status=True)
                self.save_variable(user_id, str(data.get('responseVariable') or 'response'), result, context)
                if not 200 <= status < 300:
                    raise ValueError(f'HTTP-запрос вернул статус {status}. Ответ сохранён в переменную.')
            else:
                if kind == 'inlineKeyboard' and not data.get('text') and context.get('last_message_id'):
                    self.edit_keyboard(data, context['last_message_id'], chat_id)
                    result = None
                else:
                    if kind in ['editMessage', 'deleteMessage'] and not data.get('messageId'):
                        data['messageId'] = context.get('last_message_id') or context.get('message', {}).get('message_id')
                    result = self.telegram.send_node(kind, data, chat_id)
                if isinstance(result, list) and result:
                    result = result[-1]
                if isinstance(result, dict) and result.get('message_id'):
                    self.save_variable(user_id, '_last_message_id', result['message_id'], context)
                    context['last_message_id'] = result['message_id']
            queue = next_nodes + queue

    def edit_keyboard(self, data, message_id, chat_id):
        rows = []
        for row in data.get('rows', []):
            items = []
            for button in row:
                action = button.get('action', 'callback')
                value = str(button.get('value', ''))
                item = {'text': str(button.get('text', 'Кнопка'))}
                if action == 'url':
                    if urllib.parse.urlparse(value).scheme not in ['http', 'https', 'tg']:
                        raise ValueError('У кнопки указан некорректный URL.')
                    item['url'] = value
                else:
                    item['callback_data'] = '__flowra:' + value if action in ['node', 'goto'] else value
                    if not 1 <= len(item['callback_data'].encode()) <= 64:
                        raise ValueError('Данные callback-кнопки должны занимать от 1 до 64 байт.')
                items.append(item)
            if items:
                rows.append(items)
        self.telegram.call('editMessageReplyMarkup', {'chat_id': chat_id, 'message_id': message_id, 'reply_markup': {'inline_keyboard': rows}})

    def http_request(self, data, include_status=False):
        url = str(data.get('url', ''))
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme not in ['http', 'https'] or not parsed.netloc or parsed.username or parsed.password:
            raise ValueError('HTTP-запрос требует корректный URL http:// или https:// без пароля в адресе.')
        method = str(data.get('method', 'GET')).upper()
        if method not in ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']:
            raise ValueError('Неподдерживаемый метод HTTP.')
        headers = parse_value(data.get('headers') or {})
        query = parse_value(data.get('query') or {})
        if not isinstance(headers, dict) or not isinstance(query, dict):
            raise ValueError('Заголовки и параметры HTTP должны быть JSON-объектами.')
        if query:
            url += ('&' if '?' in url else '?') + urllib.parse.urlencode(query)
        body = data.get('body')
        if body is not None and not isinstance(body, str):
            body = json.dumps(body, ensure_ascii=False)
        if body and not any(key.lower() == 'content-type' for key in headers):
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(url, data=body.encode() if body and method != 'GET' else None, headers={str(k): str(v) for k, v in headers.items()}, method=method)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as error:
            response = error
        with response:
            content = response.read(10 * 1024 * 1024 + 1)
            if len(content) > 10 * 1024 * 1024:
                raise ValueError('Ответ HTTP превышает 10 МБ.')
            value = parse_value(content.decode('utf-8', errors='replace'))
            return (value, response.status) if include_status else value
