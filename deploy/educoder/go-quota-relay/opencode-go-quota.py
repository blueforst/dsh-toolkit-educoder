#!/usr/bin/python3
"""供 DSH 容器读取的 OpenCode Go 月额度服务。"""
import ipaddress
import json
import math
import os
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM_URL = 'https://opencode.ai/inference/go/v1/usage'
BODY_LIMIT = 16384


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def read_monthly_quota(key):
    request = urllib.request.Request(UPSTREAM_URL, headers={
        'Authorization': 'Bearer ' + key,
        'Accept': 'application/json',
        'User-Agent': 'dsh-toolkit/0.2',
    })
    with OPENER.open(request, timeout=4) as response:
        if response.status != HTTPStatus.OK:
            raise ValueError('额度请求失败')
        body = response.read(BODY_LIMIT + 1)
    if len(body) > BODY_LIMIT:
        raise ValueError('额度响应过大')
    monthly = json.loads(body)['usage']['monthly']
    percent = monthly['percent']
    status = monthly['status']
    resets_at = monthly['resetsAt']
    if type(percent) not in (int, float) or not math.isfinite(percent) or not 0 <= percent <= 100:
        raise ValueError('额度百分比无效')
    if status not in ('ok', 'rate-limited') or not isinstance(resets_at, str) or len(resets_at) > 50:
        raise ValueError('额度状态无效')
    timestamp = datetime.fromisoformat(resets_at)
    if timestamp.tzinfo is None:
        raise ValueError('额度重置时间缺少时区')
    return {'usage': {'monthly': {
        'percent': percent,
        'status': status,
        'resetsAt': timestamp.isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
    }}}


class Quota:
    def __init__(self, key):
        self.key = key
        self.lock = threading.Lock()
        self.value = None
        self.next_refresh = 0.0

    def read(self):
        with self.lock:
            if time.monotonic() >= self.next_refresh:
                try:
                    self.value = read_monthly_quota(self.key)
                except (ValueError, TypeError, KeyError, OSError, OverflowError, urllib.error.URLError):
                    self.value = None
                self.next_refresh = time.monotonic() + (60 if self.value is not None else 10)
            return self.value


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send_json(self, code, value, headers=None):
        body = json.dumps(value, separators=(',', ':')).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('X-Content-Type-Options', 'nosniff')
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(body)

    def do_GET(self):
        if self.path != '/usage':
            self.send_json(404, {'error': 'not found'})
            return
        value = self.server.quota.read()
        if value is None:
            self.send_json(503, {'error': 'quota unavailable'})
        else:
            self.send_json(200, value)

    def unsupported(self):
        self.send_json(405, {'error': 'method not allowed'}, {'Allow': 'GET'})

    do_HEAD = do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_CONNECT = do_TRACE = unsupported


class Server(ThreadingHTTPServer):
    def __init__(self, address, client_network, quota):
        self.quota = quota
        self.client_network = client_network
        self.slots = threading.BoundedSemaphore(12)
        super().__init__(address, Handler)

    def get_request(self):
        conn, address = super().get_request()
        conn.settimeout(5)
        return conn, address

    def verify_request(self, request, address):
        return ipaddress.IPv4Address(address[0]) in self.client_network

    def process_request(self, request, address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, address)
        except BaseException:
            self.slots.release()
            raise

    def process_request_thread(self, request, address):
        try:
            super().process_request_thread(request, address)
        finally:
            self.slots.release()

    def handle_error(self, request, address):
        pass


def main():
    bind_address = ipaddress.IPv4Address(os.environ['DSH_GO_QUOTA_BIND'])
    client_network = ipaddress.IPv4Network(os.environ['DSH_GO_QUOTA_CLIENT_NETWORK'])
    if not client_network.is_private or bind_address not in client_network:
        raise SystemExit('额度服务必须绑定到 Docker 私有网桥')
    credential = Path(os.environ['CREDENTIALS_DIRECTORY']) / 'opencode-go.key'
    key = credential.read_text(encoding='utf-8').strip()
    if not key or len(key) > 512 or any(not 33 <= ord(c) <= 126 for c in key):
        raise SystemExit('OpenCode Go 凭据格式无效')
    with Server((str(bind_address), 9192), client_network, Quota(key)) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
