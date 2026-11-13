"""使用回环 HTTP 和替身上游检验模型转发范围。"""
import base64
import http.client
import importlib.util
import ipaddress
import json
import threading
import unittest
from email.message import Message
from io import BytesIO
from pathlib import Path

spec = importlib.util.spec_from_file_location('relay', Path(__file__).with_name('opencode-go-model.py'))
relay = importlib.util.module_from_spec(spec)
spec.loader.exec_module(relay)

SSE = b'data: {"choices":[]}\n\ndata: [DONE]\n\n'
LOCAL_TOKEN = 'relay-local-token-for-unit-test'
UPSTREAM_KEY = 'test-upstream-key'
NATIVE_PATH = '/native/v1/chat/completions'
PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'
PNG_IMAGE = {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + PNG_BASE64}}


def tool_definitions(names):
    return [{'type': 'function', 'function': {'name': name}} for name in names]


class Response(BytesIO):
    status = 200
    headers = Message()
    headers['Content-Type'] = 'text/event-stream; charset=utf-8'


class Upstream:
    def __init__(self):
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        return Response(SSE)


class RelayTest(unittest.TestCase):
    def setUp(self):
        self.upstream = Upstream()
        self.server = relay.Server(('127.0.0.1', 0), ipaddress.IPv4Network('127.0.0.1/32'),
                                   UPSTREAM_KEY, LOCAL_TOKEN, self.upstream)
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.payload = {
            'model': relay.MODEL,
            'stream': True,
            'max_tokens': 1024,
            'messages': [{'role': 'system', 'content': 'helper'}, {'role': 'user', 'content': 'solve'}],
            'tools': tool_definitions(sorted(relay.CODE_TOOLS)),
        }

    def post(self, payload=None, session='dsh-a', token=LOCAL_TOKEN, path='/v1/chat/completions'):
        conn = http.client.HTTPConnection(*self.server.server_address, timeout=4)
        try:
            headers = {'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token}
            if session is not None:
                headers['x-session-id'] = session
            conn.request('POST', path, json.dumps(self.payload if payload is None else payload), headers)
            response = conn.getresponse()
            return response.status, response.read()
        finally:
            conn.close()

    def test_request_scope(self):
        self.assertEqual(self.post(token=UPSTREAM_KEY)[0], 401)
        self.assertEqual(self.post(path='/v1/models')[0], 404)
        self.assertEqual(self.post({**self.payload, 'model': 'other'})[0], 400)
        self.assertEqual(self.post({**self.payload, 'max_tokens': 4097})[0], 400)
        self.assertEqual(self.post({**self.payload, 'tools': self.payload['tools'][:2]})[0], 400)
        self.assertEqual(len(self.upstream.requests), 0)

    def test_native_chat_streams_without_tools(self):
        native = {key: value for key, value in self.payload.items() if key != 'tools'}
        native['messages'] += [{'role': 'assistant', 'content': '你好'}, {'role': 'user', 'content': '再见'}]
        self.assertEqual(self.post(native, path=NATIVE_PATH), (200, SSE))
        self.assertEqual(self.post({**native, 'tools': []}, path=NATIVE_PATH), (200, SSE))
        for request in self.upstream.requests:
            forwarded = json.loads(request.data)
            self.assertNotIn('tools', forwarded)
            self.assertEqual(forwarded['messages'], native['messages'])

        self.assertEqual(self.post(native)[0], 400)
        self.assertEqual(self.post({**native, 'tools': []})[0], 400)
        self.assertEqual(self.post({**native, 'tools': None}, path=NATIVE_PATH)[0], 400)
        self.assertEqual(self.post(native, token=UPSTREAM_KEY, path=NATIVE_PATH)[0], 401)
        self.assertEqual(len(self.upstream.requests), 2)

    def test_native_functions_and_tool_history_are_preserved(self):
        function = {'name': 'Bash', 'description': '运行命令', 'parameters': {'type': 'object'}}
        native = {**self.payload, 'tools': [{'type': 'function', 'function': function}],
                  'messages': [*self.payload['messages'],
                               {'role': 'assistant', 'content': None, 'tool_calls': [
                                   {'type': 'function', 'id': 'call-1', 'function': {
                                       'name': 'Bash', 'arguments': '{"command":"pwd"}'}}]},
                               {'role': 'tool', 'tool_call_id': 'call-1', 'content': '/workspace'}]}
        self.assertEqual(self.post(native, path=NATIVE_PATH), (200, SSE))
        forwarded = json.loads(self.upstream.requests[0].data)
        self.assertEqual(forwarded['tools'], native['tools'])
        self.assertEqual(forwarded['messages'], native['messages'])
        self.assertEqual(self.post(native)[0], 400)

        invalid = [tool_definitions(['invalid tool name']), native['tools'] * 2,
                   [{'type': 'function', 'function': {**function, 'parameters': 'invalid'}}],
                   [{'type': 'custom', 'custom': {'name': 'native'}}],
                   tool_definitions(f'tool-{index}' for index in range(relay.MAX_NATIVE_TOOLS + 1))]
        for tools in invalid:
            self.assertEqual(self.post({**native, 'tools': tools}, path=NATIVE_PATH)[0], 400)
        self.assertEqual(len(self.upstream.requests), 1)

    def test_only_forwards_known_assignment_tool_combinations(self):
        code = ['educoder_read_file', 'educoder_save_file', 'educoder_evaluate']
        terminal = ['educoder_terminal', 'educoder_evaluate']
        browser = ['educoder_browser']
        experience = ['educoder_record_experience']
        code_and_terminal = code + terminal[:1]
        permitted = [code, code + browser, terminal, terminal + browser, browser,
                     code_and_terminal, code_and_terminal + browser]
        for names in permitted + [names + experience for names in permitted]:
            with self.subTest(names=names):
                tools = tool_definitions(names)
                self.assertEqual(self.post({**self.payload, 'tools': tools}), (200, SSE))
                self.assertEqual(json.loads(self.upstream.requests[-1].data)['tools'], tools)

        rejected = [experience, terminal[:1], browser + terminal[1:], code[:1] + terminal,
                    terminal + ['bash'], code + ['educoder_read_file'], browser + browser,
                    browser + ['educoder_browser_inspect'], browser + experience + experience]
        for names in rejected:
            with self.subTest(names=names):
                self.assertEqual(self.post({**self.payload, 'tools': tool_definitions(names)})[0], 400)
        self.assertEqual(len(self.upstream.requests), 2 * len(permitted))

    def test_stream_and_stable_session(self):
        followup = {**self.payload, 'messages': [*self.payload['messages'], {'role': 'tool', 'content': 'result'}]}
        self.assertEqual(self.post(), (200, SSE))
        self.assertEqual(self.post(followup)[0], 200)
        self.assertEqual(self.post(session='dsh-b')[0], 200)
        self.assertEqual(self.post(session=None)[0], 200)
        self.assertEqual(self.post(followup, session=None)[0], 200)
        first = self.upstream.requests[0]
        self.assertEqual(first.get_header('Authorization'), 'Bearer ' + UPSTREAM_KEY)
        payload = json.loads(first.data)
        self.assertEqual(payload['thinking'], {'type': 'disabled'})
        self.assertEqual(payload['stream_options'], {'include_usage': True})
        sessions = [request.get_header('X-opencode-session') for request in self.upstream.requests]
        self.assertEqual(sessions[0], sessions[1])
        self.assertNotEqual(sessions[0], sessions[2])
        self.assertEqual(sessions[3], sessions[4])
        self.assertTrue(all(value.startswith('edu-') and 'dsh-' not in value for value in sessions))

    def test_user_images_are_forwarded_with_text(self):
        messages = [self.payload['messages'][0], {'role': 'user', 'content': [
            {'type': 'text', 'text': '参考图片'}, PNG_IMAGE,
        ]}, {'role': 'assistant', 'content': None, 'tool_calls': []}]
        self.assertEqual(self.post({**self.payload, 'messages': messages}), (200, SSE))
        forwarded = json.loads(self.upstream.requests[0].data)
        self.assertEqual(forwarded['messages'], messages)

    def test_dsh_prompt_cache_key_sets_session_without_forwarding_openai_options(self):
        payload = {**self.payload, 'prompt_cache_key': 'dsh-session-a', 'prompt_cache_retention': '24h'}
        changed = {**payload, 'messages': [{'role': 'user', 'content': 'another prompt'}]}
        self.assertEqual(self.post(payload, session=None)[0], 200)
        self.assertEqual(self.post(changed, session=None)[0], 200)
        self.assertEqual(self.post({**payload, 'prompt_cache_key': 'dsh-session-b'}, session=None)[0], 200)
        self.assertEqual(self.post({**payload, 'prompt_cache_key': 'bad key'}, session=None)[0], 400)
        sessions = [request.get_header('X-opencode-session') for request in self.upstream.requests]
        self.assertEqual(sessions[0], sessions[1])
        self.assertNotEqual(sessions[0], sessions[2])
        for request in self.upstream.requests:
            forwarded = json.loads(request.data)
            self.assertNotIn('prompt_cache_key', forwarded)
            self.assertNotIn('prompt_cache_retention', forwarded)

    def test_rejects_untrusted_and_oversized_images(self):
        def image(url):
            return {'type': 'image_url', 'image_url': {'url': url}}

        oversized = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'X' * relay.MAX_IMAGE_BYTES).decode('ascii')
        cases = [
            ('user', [image('https://example.invalid/image.png')]),
            ('user', [image('data:image/svg+xml;base64,' + PNG_BASE64)]),
            ('user', [image('data:image/jpeg;base64,' + PNG_BASE64)]),
            ('user', [image('data:image/png;base64,###')]),
            ('user', [image('data:image/png;base64,' + oversized)]),
            ('user', [PNG_IMAGE] * (relay.MAX_IMAGES + 1)),
            ('user', [PNG_IMAGE, {'type': 'text', 'text': 'x' * relay.TEXT_BODY_LIMIT}]),
            ('tool', [PNG_IMAGE]),
        ]
        for role, content in cases:
            with self.subTest(role=role, parts=len(content)):
                messages = [*self.payload['messages'], {'role': role, 'content': content}]
                self.assertEqual(self.post({**self.payload, 'messages': messages})[0], 400)
        self.assertEqual(self.upstream.requests, [])

    def test_native_supports_larger_images_and_longer_history(self):
        def sized_image(size):
            encoded = base64.b64encode(b'\x89PNG\r\n\x1a\n' + b'X' * (size - 8)).decode('ascii')
            return {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + encoded}}

        native_image = sized_image(relay.MAX_NATIVE_IMAGE_BYTES)
        messages = [{'role': 'user', 'content': [native_image, native_image]}]
        native = {**self.payload, 'messages': messages}
        self.assertEqual(self.post(native, path=NATIVE_PATH), (200, SSE))
        smaller = [{'role': 'user', 'content': [sized_image(relay.MAX_IMAGE_BYTES + 1)]}]
        self.assertEqual(self.post({**native, 'messages': smaller})[0], 400)

        for images in ([native_image, native_image, PNG_IMAGE], [sized_image(relay.MAX_NATIVE_IMAGE_BYTES + 1)]):
            self.assertEqual(self.post({**native, 'messages': [{'role': 'user', 'content': images}]}, path=NATIVE_PATH)[0], 400)

        longer = [{'role': 'user', 'content': '继续'}] * (relay.MAX_MESSAGES + 1)
        self.assertEqual(self.post({**native, 'messages': longer}, path=NATIVE_PATH)[0], 200)
        self.assertEqual(self.post({**native, 'messages': longer})[0], 400)
        self.assertEqual(self.post({**native, 'messages': longer * 4}, path=NATIVE_PATH)[0], 400)

    def test_native_replays_images_across_stages(self):
        stages = [{'role': 'user', 'content': [
            {'type': 'text', 'text': f'第 {stage} 关'}, *([PNG_IMAGE] * 4),
        ]} for stage in (1, 2)]
        native = {**self.payload, 'messages': [*self.payload['messages'], *stages]}
        self.assertEqual(self.post(native, path=NATIVE_PATH), (200, SSE))
        self.assertEqual(json.loads(self.upstream.requests[0].data)['messages'], native['messages'])
        self.assertEqual(self.post(native)[0], 400)

        excessive = {'role': 'user', 'content': [PNG_IMAGE] * (relay.MAX_NATIVE_IMAGES - 8 + 1)}
        self.assertEqual(self.post({**native, 'messages': [*native['messages'], excessive]}, path=NATIVE_PATH)[0], 400)
        self.assertEqual(len(self.upstream.requests), 1)

    def test_session_limit(self):
        for _ in range(relay.SESSION_LIMIT):
            self.assertEqual(self.post()[0], 200)
        self.assertEqual(self.post()[0], 429)
        self.assertEqual(self.post(path=NATIVE_PATH)[0], 200)
        self.assertEqual(self.post(session='dsh-b')[0], 200)


if __name__ == '__main__':
    unittest.main()
