import json
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src' / 'exporter' / 'python'))

from api import Telegram
from engine import Engine, compare, render
from storage import Store
from index import UpdateQueue


class CaptureTelegram(Telegram):
    def __init__(self, root):
        super().__init__('123456:' + 'a' * 30, root)
        self.calls = []

    def call(self, method, payload=None):
        self.calls.append((method, payload or {}))
        return {'message_id': len(self.calls) + 100}


def message(text, update_id=1, user_id=77):
    return {'update_id': update_id, 'message': {'message_id': update_id, 'chat': {'id': user_id}, 'from': {'id': user_id, 'first_name': 'Ира'}, 'text': text}}


def node(node_id, kind, **data):
    return {'id': node_id, 'type': kind, 'data': data, 'position': {'x': 0, 'y': 0}}


def edge(source, target, handle=None):
    return {'id': f'{source}-{target}', 'source': source, 'target': target, 'sourceHandle': handle}


def check_runtime(root):
    telegram = CaptureTelegram(root)
    store = Store(root / 'bot.db')
    workflow = {'nodes': [node('s', 'start'), node('ask', 'input', variable='name', inputType='text', prompt='Ваше имя?'), node('check', 'condition', variable='name', operator='equals', value='Лена'), node('yes', 'sendMessage', text='Привет, {{name}}! {{user.first_name}}'), node('no', 'sendMessage', text='Другое имя')], 'edges': [edge('s', 'ask'), edge('ask', 'check'), edge('check', 'yes', 'true'), edge('check', 'no', 'false')]}
    Engine(workflow, telegram, store).process_update(message('/start'))
    user_id = store.db.execute('SELECT id FROM users').fetchone()[0]
    assert store.current_node(user_id) == 'ask'
    store.close()
    store = Store(root / 'bot.db')
    Engine(workflow, telegram, store).process_update(message('Лена', 2))
    assert store.variables(user_id)['name'] == 'Лена'
    assert store.current_node(user_id) is None
    assert telegram.calls[-1][1]['text'] == 'Привет, Лена! Ира'
    Engine(workflow, telegram, store).process_update(message('/start', 3))
    assert store.db.execute('SELECT COUNT(*) FROM users').fetchone()[0] == 1
    assert store.db.execute('SELECT message_count FROM users').fetchone()[0] == 3
    store.set_offset(345)
    store.close()
    store = Store(root / 'bot.db')
    assert store.get_offset() == 345
    assert store.current_node(user_id) == 'ask'
    workflow['nodes'][1]['data']['inputType'] = 'number'
    Engine(workflow, telegram, store).process_update(message('не число', 4))
    assert store.current_node(user_id) == 'ask'
    Engine(workflow, telegram, store).process_update(message('42', 5))
    assert store.variables(user_id)['name'] == 42
    assert store.current_node(user_id) is None
    store.close()


def check_payloads(root):
    telegram = CaptureTelegram(root)
    configurations = {
        'sendMessage': {'text': 'Текст'},
        'sendPhoto': {'media': 'photo_file_id'},
        'sendVideo': {'media': 'video_file_id'},
        'sendAudio': {'media': 'audio_file_id'},
        'sendVoice': {'media': 'voice_file_id'},
        'sendDocument': {'media': 'doc_file_id'},
        'sendLocation': {'latitude': '41.3', 'longitude': '69.2'},
        'sendContact': {'phoneNumber': '+998901234567', 'firstName': 'Имя'},
        'sendPoll': {'question': 'Вопрос?', 'answers': ['Да', 'Нет'], 'multiple': True},
        'sendQuiz': {'question': 'Вопрос?', 'answers': ['Да', 'Нет'], 'correctAnswer': 1},
        'sendMediaGroup': {'items': [{'type': 'photo', 'media': 'photo_file_id'}, {'type': 'video', 'media': 'video_file_id'}]},
        'editMessage': {'text': 'Новый текст', 'messageId': 10},
        'deleteMessage': {'messageId': 10},
        'inlineKeyboard': {'text': 'Кнопки', 'rows': [[{'text': 'Вперёд', 'action': 'node', 'value': 'next'}]]},
        'replyKeyboard': {'text': 'Кнопки', 'rows': [[{'text': 'Контакт', 'action': 'contact'}, {'text': 'Адрес', 'action': 'location'}]]},
        'urlButton': {'text': 'Ссылка', 'buttonText': 'Открыть', 'url': 'https://example.com'},
    }
    for kind, data in configurations.items():
        telegram.send_node(kind, data, 77)
    quiz = next(payload for method, payload in telegram.calls if payload.get('type') == 'quiz')
    assert quiz['correct_option_ids'] == [1]
    assert quiz['options'] == [{'text': 'Да'}, {'text': 'Нет'}]
    album = next(payload for method, payload in telegram.calls if method == 'sendMediaGroup')
    assert len(album['media']) == 2
    inline = next(payload for method, payload in telegram.calls if payload.get('text') == 'Кнопки' and 'inline_keyboard' in payload.get('reply_markup', {}))
    assert inline['reply_markup']['inline_keyboard'][0][0]['callback_data'] == '__flowra:next'
    reply = next(payload for method, payload in telegram.calls if 'keyboard' in payload.get('reply_markup', {}))
    assert reply['reply_markup']['keyboard'][0][0]['request_contact']
    assert reply['reply_markup']['keyboard'][0][1]['request_location']
    assets = root / 'assets'
    assets.mkdir()
    photo = assets / 'photo.png'
    photo.write_bytes(b'\x89PNG\r\n\x1a\n')
    body, content_type = telegram._multipart({'chat_id': 77, 'media': [{'type': 'photo', 'media': 'attach://p'}]}, {'p': photo})
    assert b'filename="photo.png"' in body and b'attach://p' in body and 'multipart/form-data' in content_type
    assert telegram._file('assets/photo.png') == photo
    try:
        telegram._file('../outside.txt')
        raise AssertionError('Traversal was allowed')
    except ValueError:
        pass


def check_logic(root):
    telegram = CaptureTelegram(root)
    store = Store(root / 'logic.db')
    workflow = {'nodes': [node('s', 'start'), node('set', 'setVariable', variable='score', value='5'), node('get', 'getVariable', variable='score', target='copy'), node('switch', 'switch', variable='copy', cases=[{'value': '5', 'label': 'five'}]), node('delay', 'delay', seconds=0), node('random', 'random'), node('reply', 'sendMessage', text='{{variable.copy}}')], 'edges': [edge('s', 'set'), edge('set', 'get'), edge('get', 'switch'), edge('switch', 'delay', 'five'), edge('delay', 'random'), edge('random', 'reply')]}
    Engine(workflow, telegram, store).process_update(message('/start'))
    assert telegram.calls[-1][1]['text'] == '5'
    assert compare(5, 'greater or equal', '5')
    assert compare(None, 'exists', '') is False
    assert render('{{place.latitude}} {{variable.score}}', {'place': {'latitude': 10}, 'score': 5}) == '10 5'
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'ok': True}).encode())

        def log_message(self, format, *args):
            pass
    server = HTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        engine = Engine(workflow, telegram, store)
        assert engine.http_request({'url': f'http://127.0.0.1:{server.server_port}/test', 'method': 'GET'}) == {'ok': True}
        try:
            engine.http_request({'url': 'file:///etc/passwd'})
            raise AssertionError('Invalid scheme allowed')
        except ValueError:
            pass
    finally:
        server.shutdown()
        server.server_close()
        thread.join()
        store.close()


def check_queue():
    stop_event = threading.Event()
    started = threading.Event()
    release = threading.Event()
    other_done = threading.Event()
    same_done = threading.Event()
    errors = []
    class SlowEngine:
        def process_update(self, update):
            text = update['message']['text']
            if text == 'slow':
                started.set()
                release.wait(3)
            elif text == 'same':
                same_done.set()
            else:
                other_done.set()
    updates = UpdateQueue(SlowEngine(), stop_event, errors.append, worker_count=2)
    try:
        updates.enqueue(message('slow', 1, 77))
        assert started.wait(1)
        updates.enqueue(message('same', 2, 77))
        updates.enqueue(message('other', 3, 88))
        assert other_done.wait(1), 'Delay blocked another user'
        assert not same_done.is_set(), 'Updates for one user ran concurrently'
        release.set()
        assert same_done.wait(1)
        assert not errors
    finally:
        release.set()
        assert updates.close()


for source in (Path(__file__).resolve().parents[1] / 'src' / 'exporter' / 'python').glob('*.py'):
    compile(source.read_text(encoding='utf-8'), str(source), 'exec')

with tempfile.TemporaryDirectory(prefix='flowra-python-') as directory:
    root = Path(directory)
    check_runtime(root)
    check_payloads(root)
    check_logic(root)
    check_queue()
print('Python runtime: OK')
