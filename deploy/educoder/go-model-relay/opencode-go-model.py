#!/usr/bin/python3
"""将专用 EduCoder 实例的受限模型请求转发到 OpenCode Go。"""
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

UPSTREAM_URL = 'https://opencode.ai/inference/go/openai/v1/chat/completions'
MODEL = 'deepseek-v4.1-flash'
CODE_TOOLS = frozenset({'educoder_read_file', 'educoder_save_file', 'educoder_evaluate'})
TERMINAL_TOOLS = frozenset({'educoder_terminal', 'educoder_evaluate'})
BROWSER_TOOL = frozenset({'educoder_browser'})
EXPERIENCE_TOOL = frozenset({'educoder_record_experience'})
TASK_TOOL_SETS = {
    CODE_TOOLS,
    CODE_TOOLS | BROWSER_TOOL,
    TERMINAL_TOOLS,
    TERMINAL_TOOLS | BROWSER_TOOL,
    CODE_TOOLS | TERMINAL_TOOLS,
    CODE_TOOLS | TERMINAL_TOOLS | BROWSER_TOOL,
    BROWSER_TOOL,
}
ALLOWED_TOOL_SETS = TASK_TOOL_SETS | {tools | EXPERIENCE_TOOL for tools in TASK_TOOL_SETS}
MAX_TOOLS = max(map(len, ALLOWED_TOOL_SETS))
MAX_NATIVE_TOOLS = 256
NATIVE_TOOL_NAME = re.compile(r'[A-Za-z0-9_-]{1,64}')
MESSAGE_ROLES = {'system', 'user', 'assistant', 'tool'}
TEXT_BODY_LIMIT = 8 * 1024 * 1024
MAX_IMAGES = 16
MAX_IMAGE_BYTES = 2 * 1024 * 1024
MAX_NATIVE_IMAGES = 128
MAX_NATIVE_IMAGE_BYTES = 4 * 1024 * 1024
MAX_NATIVE_TOTAL_IMAGE_BYTES = 32 * 1024 * 1024
# 独立编码的每张图各自带尾部填充，最坏额外占用 4 字节。
BODY_LIMIT = TEXT_BODY_LIMIT + MAX_IMAGES * (((MAX_IMAGE_BYTES + 2) // 3) * 4)
NATIVE_BODY_LIMIT = TEXT_BODY_LIMIT + (((MAX_NATIVE_TOTAL_IMAGE_BYTES + 2) // 3) * 4) + 4 * MAX_NATIVE_IMAGES
OUTPUT_LIMIT = 32 * 1024 * 1024
MAX_OUTPUT_TOKENS = 384000
SESSION_HEADER = re.compile(r'[A-Za-z0-9._:-]{1,128}')
IMAGE_PREFIXES = {
    'data:image/png;base64': (b'\x89PNG\r\n\x1a\n',),
    'data:image/jpeg;base64': (b'\xff\xd8\xff',),
    'data:image/webp;base64': (b'RIFF',),
    'data:image/gif;base64': (b'GIF87a', b'GIF89a'),
}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode('utf-8')


def image_size(part, max_bytes):
    source = part.get('image_url')
    if not isinstance(source, dict) or set(source) != {'url'} or not isinstance(source['url'], str):
        raise ValueError('invalid image source')
    prefix, _, encoded = source['url'].partition(',')
    signatures = IMAGE_PREFIXES.get(prefix)
    if signatures is None or not 1 <= len(encoded) <= ((max_bytes + 2) // 3) * 4:
        raise ValueError('invalid image data URL')
    try:
        image = base64.b64decode(encoded, validate=True)
    except ValueError as error:
        raise ValueError('invalid image encoding') from error
    if len(image) > max_bytes or not image.startswith(signatures) or (
            prefix == 'data:image/webp;base64' and image[8:12] != b'WEBP'):
        raise ValueError('invalid image data')
    return len(image), len(encoded)


def validate_message_content(messages, body_size, native):
    max_images = MAX_NATIVE_IMAGES if native else MAX_IMAGES
    max_image_bytes = MAX_NATIVE_IMAGE_BYTES if native else MAX_IMAGE_BYTES
    max_total_bytes = MAX_NATIVE_TOTAL_IMAGE_BYTES if native else MAX_IMAGES * MAX_IMAGE_BYTES
    images = 0
    image_bytes = 0
    encoded_image_bytes = 0
    for message in messages:
        content = message.get('content')
        if content is None and message['role'] == 'assistant':
            continue
        if isinstance(content, str):
            continue
        if not isinstance(content, list) or not content:
            raise ValueError('invalid message content')
        for part in content:
            if not isinstance(part, dict):
                raise ValueError('invalid content part')
            if part.get('type') == 'text' and set(part) == {'type', 'text'} and isinstance(part['text'], str):
                continue
            if (part.get('type') != 'image_url' or set(part) != {'type', 'image_url'}
                    or message['role'] != 'user' or images >= max_images):
                raise ValueError('invalid image part')
            decoded_size, encoded_size = image_size(part, max_image_bytes)
            image_bytes += decoded_size
            if image_bytes > max_total_bytes:
                raise ValueError('total image data is too large')
            encoded_image_bytes += encoded_size
            images += 1
    if body_size - encoded_image_bytes > TEXT_BODY_LIMIT:
        raise ValueError('text request is too large')


def parse_payload(body, *, native=False):
    data = json.loads(body)
    if not isinstance(data, dict) or data.get('model') != MODEL or data.get('stream') is not True:
        raise ValueError('invalid model')
    tools = data.get('tools', [] if native else None)
    tool_limit = MAX_NATIVE_TOOLS if native else MAX_TOOLS
    if not isinstance(tools, list) or len(tools) > tool_limit:
        raise ValueError('invalid tools')
    names = set()
    for tool in tools:
        if not isinstance(tool, dict) or tool.get('type') != 'function':
            raise ValueError('invalid tool')
        function = tool.get('function')
        if not isinstance(function, dict) or not isinstance(function.get('name'), str):
            raise ValueError('invalid tool function')
        if native and (not NATIVE_TOOL_NAME.fullmatch(function['name'])
                       or not isinstance(function.get('parameters', {}), dict)
                       or not isinstance(function.get('description', ''), str)):
            raise ValueError('invalid native tool declaration')
        names.add(function['name'])
    if len(names) != len(tools) or (not native and frozenset(names) not in ALLOWED_TOOL_SETS):
        raise ValueError('invalid tool scope')
    messages = data.get('messages')
    if not isinstance(messages, list) or not messages:
        raise ValueError('invalid messages')
    if any(not isinstance(entry, dict) or entry.get('role') not in MESSAGE_ROLES for entry in messages):
        raise ValueError('invalid message role')
    validate_message_content(messages, len(body), native)
    first_user = next((index for index, entry in enumerate(messages) if entry['role'] == 'user'), None)
    if first_user is None:
        raise ValueError('missing user message')
    tokens = data.get('max_tokens', data.get('max_completion_tokens'))
    if type(tokens) is not int or not 1 <= tokens <= MAX_OUTPUT_TOKENS:
        raise ValueError('invalid output limit')
    cache_key = data.get('prompt_cache_key')
    if cache_key is not None and (not isinstance(cache_key, str) or not SESSION_HEADER.fullmatch(cache_key)):
        raise ValueError('invalid prompt cache key')
    return {
        'model': MODEL,
        'messages': messages,
        **({'tools': tools} if tools else {}),
        'max_tokens': tokens,
        'stream': True,
        'stream_options': {'include_usage': True},
        'thinking': {'type': 'disabled'},
    }, messages[:first_user + 1], cache_key


def session_id(headers, token, prompt_prefix, cache_key=None):
    for name in ('x-opencode-session', 'x-session-id', 'session_id', 'x-session-affinity'):
        value = headers.get(name)
        if value and SESSION_HEADER.fullmatch(value):
            seed = ('id:' + value).encode()
            break
    else:
        seed = ('id:' + cache_key).encode() if cache_key else b'prompt:' + encode(prompt_prefix)
    return 'edu-' + hmac.new(token.encode(), seed, hashlib.sha256).hexdigest()[:32]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def error_response(self, code, error):
        body = encode({'error': {'message': error}})
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        native = self.path == '/native/v1/chat/completions'
        if not native and self.path != '/v1/chat/completions':
            self.error_response(404, '未知模型接口。')
            return
        auth = self.headers.get('Authorization', '')
        if not hmac.compare_digest(auth.encode(), self.server.client_auth):
            self.error_response(401, '模型转发认证失败。')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            body_limit = NATIVE_BODY_LIMIT if native else BODY_LIMIT
            if not 1 <= length <= body_limit or self.headers.get('Transfer-Encoding'):
                raise ValueError('invalid body length')
            if self.headers.get_content_type() != 'application/json':
                raise ValueError('invalid content type')
            body = self.rfile.read(length)
            if len(body) != length:
                raise ValueError('incomplete body')
            payload, prompt_prefix, cache_key = parse_payload(body, native=native)
            session = session_id(self.headers, self.server.token, prompt_prefix, cache_key)
        except (ValueError, TypeError, OSError, RecursionError):
            self.error_response(400, '请求不符合 EduCoder 模型范围。')
            return

        request = urllib.request.Request(UPSTREAM_URL, data=encode(payload), headers={
            'Authorization': 'Bearer ' + self.server.key,
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            'User-Agent': 'dsh-educoder/0.1',
            'X-OpenCode-Session': session,
        })
        try:
            response = self.server.opener.open(request, timeout=300)
        except urllib.error.HTTPError as error:
            error.close()
            status = 429 if error.code == 429 else 502
            self.error_response(status, 'OpenCode Go 拒绝了模型请求。')
            return
        except OSError:
            self.error_response(502, 'OpenCode Go 模型暂时不可用。')
            return

        with response:
            if response.status != 200 or response.headers.get_content_type() != 'text/event-stream':
                self.error_response(502, 'OpenCode Go 返回了无效的模型响应。')
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.send_header('Cache-Control', 'no-store')
            self.send_header('Connection', 'close')
            self.end_headers()
            size = 0
            deadline = time.monotonic() + 1800
            try:
                while time.monotonic() < deadline:
                    chunk = response.read1(min(32768, OUTPUT_LIMIT - size + 1))
                    if not chunk:
                        return
                    size += len(chunk)
                    if size > OUTPUT_LIMIT:
                        return
                    self.wfile.write(chunk)
                    self.wfile.flush()
            except OSError:
                # 浏览器任务已取消或上游连接中断。
                return


class Server(ThreadingHTTPServer):
    def __init__(self, address, client_network, key, token, opener=OPENER):
        self.client_network = client_network
        self.key = key
        self.token = token
        self.client_auth = ('Bearer ' + token).encode()
        self.opener = opener
        self.slots = threading.BoundedSemaphore(64)
        super().__init__(address, Handler)

    def get_request(self):
        conn, address = super().get_request()
        conn.settimeout(60)
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


def credential(directory, name, minimum):
    value = (directory / name).read_text(encoding='utf-8').strip()
    if not minimum <= len(value) <= 512 or any(not 33 <= ord(c) <= 126 for c in value):
        raise SystemExit('模型转发凭据格式无效。')
    return value


def main():
    bind = ipaddress.IPv4Address(os.environ['DSH_GO_MODEL_BIND'])
    network = ipaddress.IPv4Network(os.environ['DSH_GO_MODEL_CLIENT_NETWORK'])
    if not bind.is_private or not network.is_private or bind.is_unspecified or bind.is_multicast:
        raise SystemExit('模型转发服务需要私有网桥地址。')
    directory = Path(os.environ['CREDENTIALS_DIRECTORY'])
    key = credential(directory, 'opencode-go.key', 1)
    token = credential(directory, 'educoder-go-relay.token', 32)
    if hmac.compare_digest(key, token):
        raise SystemExit('模型转发必须使用独立的访问令牌。')
    with Server((str(bind), 9193), network, key, token) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
