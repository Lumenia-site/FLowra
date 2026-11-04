import json
import os
import queue
import re
import threading
import time
from collections import deque
from pathlib import Path

from api import Telegram, TelegramError
from engine import Engine
from storage import Store


class UpdateQueue:
    def __init__(self, engine, stop_event, on_error, worker_count=16, capacity=100):
        self.engine = engine
        self.stop_event = stop_event
        self.on_error = on_error
        self.lock = threading.Lock()
        self.capacity = threading.BoundedSemaphore(capacity)
        self.keys = queue.Queue()
        self.pending = {}
        self.workers = [threading.Thread(target=self.work, daemon=True) for _ in range(worker_count)]
        for worker in self.workers:
            worker.start()

    def enqueue(self, update):
        while not self.stop_event.is_set():
            if self.capacity.acquire(timeout=0.2):
                break
        else:
            raise InterruptedError('Бот остановлен.')
        callback = update.get('callback_query') or {}
        message = update.get('message') or callback.get('message') or {}
        profile = callback.get('from') or message.get('from') or {}
        key = profile.get('id', update.get('update_id'))
        with self.lock:
            if key not in self.pending:
                self.pending[key] = deque([update])
                self.keys.put(key)
            else:
                self.pending[key].append(update)

    def work(self):
        while not self.stop_event.is_set():
            try:
                key = self.keys.get(timeout=0.2)
            except queue.Empty:
                continue
            with self.lock:
                update = self.pending[key][0]
            try:
                self.engine.process_update(update)
            except Exception as error:
                if not self.stop_event.is_set():
                    self.on_error(error)
            finally:
                with self.lock:
                    self.pending[key].popleft()
                    if self.pending[key] and not self.stop_event.is_set():
                        self.keys.put(key)
                    else:
                        del self.pending[key]
                self.capacity.release()
                self.keys.task_done()

    def close(self):
        self.stop_event.set()
        deadline = time.monotonic() + 2
        for worker in self.workers:
            worker.join(timeout=max(0, deadline - time.monotonic()))
        return all(not worker.is_alive() for worker in self.workers)


def load_token(root):
    filename = root / '.env'
    if filename.is_file():
        for line in filename.read_text(encoding='utf-8-sig').splitlines():
            line = line.strip()
            if line.startswith('TELEGRAM_BOT_TOKEN=') and 'TELEGRAM_BOT_TOKEN' not in os.environ:
                os.environ['TELEGRAM_BOT_TOKEN'] = line.split('=', 1)[1].strip().strip('"\'')
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    if not re.fullmatch(r'\d+:[A-Za-z0-9_-]{20,}', token):
        raise ValueError('Укажите TELEGRAM_BOT_TOKEN в .env. Токен можно получить у @BotFather.')
    return token


def main():
    root = Path(__file__).resolve().parent
    token = load_token(root)
    workflow = json.loads((root / 'workflow.json').read_text(encoding='utf-8-sig'))
    if not isinstance(workflow.get('nodes'), list) or not isinstance(workflow.get('edges'), list):
        raise ValueError('Некорректный workflow.json: нужны массивы nodes и edges.')
    stop_event = threading.Event()
    telegram = Telegram(token, root, stop_event)
    me = telegram.call('getMe')
    webhook = telegram.call('getWebhookInfo')
    if webhook.get('url'):
        raise ValueError('У бота установлен webhook. Отключите его у своего сервиса перед запуском в режиме getUpdates.')
    store = Store(root / 'bot.db')
    engine = Engine(workflow, telegram, store, stop_event)
    updates_queue = UpdateQueue(engine, stop_event, lambda error: print(f'Ошибка сценария: {str(error).replace(token, "[скрыто]")}', flush=True))
    print(f'Бот @{me.get("username", "")} запущен. Ctrl+C — остановить.', flush=True)
    try:
        while not stop_event.is_set():
            try:
                updates = telegram.call('getUpdates', {'offset': store.get_offset(), 'timeout': 30, 'allowed_updates': ['message', 'callback_query']})
                for update in updates:
                    updates_queue.enqueue(update)
                    store.set_offset(update['update_id'] + 1)
            except TelegramError as error:
                if error.code in [401, 409]:
                    raise
                print(str(error).replace(token, '[скрыто]'), flush=True)
                stop_event.wait(3)
            except (OSError, RuntimeError) as error:
                print(str(error).replace(token, '[скрыто]'), flush=True)
                stop_event.wait(3)
    except KeyboardInterrupt:
        print('Бот остановлен.', flush=True)
    finally:
        if updates_queue.close():
            store.close()


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
        message = str(error)
        if token:
            message = message.replace(token, '[скрыто]')
        print(f'Не удалось запустить бота: {message}', flush=True)
        raise SystemExit(1)
