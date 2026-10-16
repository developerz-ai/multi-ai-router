import gzip
import importlib.util
import json
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path

# Hooks operate on HTTPFlow attributes only. No network, provider, or optional mitm installation.
sys.dont_write_bytecode = True
sys.modules['mitmproxy'] = types.SimpleNamespace(http=types.SimpleNamespace(HTTPFlow=object))
sys.modules['mitmproxy.net'] = types.SimpleNamespace(encoding=types.SimpleNamespace(
    decode=lambda data, kind: gzip.decompress(data) if kind == 'gzip' else data))


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ['CLAUDE_TRACE_DIR'] = self.tmp.name
        os.environ.pop('CLAUDE_TRACE_PRIVATE', None)
        spec = importlib.util.spec_from_file_location('capture', Path(__file__).with_name('capture.py'))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def tearDown(self):
        self.tmp.cleanup()

    def flow(self):
        body = {'model': 'claude-opus-5-5', 'max_tokens': 64,
            'system': [{'type': 'text', 'text': 'x-anthropic-billing-header: cc_version=2.1.301.123; cc_entrypoint=cli; cch=12345; cc_prompt_id=private-prompt; cc_turn_origin=human;'}],
            'messages': [{'role': 'user', 'content': 'private-prompt-text'}],
            'metadata': {'user_id': json.dumps({'device_id': 'private-device',
                'account_uuid': 'private-account', 'session_id': 'private-session'})}}
        request = types.SimpleNamespace(host='api.anthropic.com', method='POST',
            path='/v1/messages?beta=true', query={'beta': 'true'}, http_version='HTTP/1.1',
            headers={'Authorization': 'Bearer private-secret', 'User-Agent': 'claude-cli/test',
                'X-Claude-Code-Session-Id': 'private-session', 'X-Unknown': 'private-secret'},
            content=json.dumps(body).encode())
        return types.SimpleNamespace(request=request, metadata={},
            response=types.SimpleNamespace(status_code=200, http_version='HTTP/2',
                headers={'content-type': 'text/event-stream', 'set-cookie': 'private-secret',
                    'anthropic-ratelimit-unified-status': 'allowed'}))

    def test_stream_and_secrets(self):
        flow = self.flow()
        self.module.request(flow)
        self.module.responseheaders(flow)
        chunks = [b'event: message_start\ndata: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":123}}}\n\n',
            b'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"private-reply"}}\n\n',
            b'event: message_stop\ndata: {"type":"message_stop"}\n\n']
        for chunk in chunks:
            self.assertEqual(flow.response.stream(chunk), chunk)
        self.module.response(flow)
        path = Path(self.tmp.name) / 'flows.jsonl'
        text = path.read_text()
        for secret in ['private-secret', 'private-prompt-text', 'private-reply',
                       'private-device', 'private-account', 'private-session', 'private-prompt']:
            self.assertNotIn(secret, text)
        record = json.loads(text)
        self.assertTrue(record['beta_query'])
        self.assertEqual(record['chunks'], 3)
        self.assertEqual(record['headers']['x-claude-code-session-id'],
            record['body']['metadata']['user_id']['session_id'])
        self.assertEqual(record['events'][0]['message']['usage']['cache_read_input_tokens'], 123)
        self.assertNotIn('set-cookie', record['response_headers'])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse((Path(self.tmp.name) / 'private-bodies.jsonl').exists())

    def test_gzip_stream_is_forwarded_compressed_but_analyzed_decoded(self):
        flow = self.flow()
        flow.response.headers['content-encoding'] = 'gzip'
        self.module.request(flow)
        self.module.responseheaders(flow)
        chunk = gzip.compress(b'data: {"type":"message_start","message":{"usage":{"cache_read_input_tokens":789}}}\n\n')
        self.assertEqual(flow.response.stream(chunk), chunk)
        self.module.response(flow)
        record = json.loads((Path(self.tmp.name) / 'flows.jsonl').read_text())
        self.assertEqual(record['events'][0]['message']['usage']['cache_read_input_tokens'], 789)

    def test_private_wire_requires_explicit_opt_in_and_excludes_auth_headers(self):
        self.module.PRIVATE = True
        flow = self.flow()
        self.module.request(flow)
        raw = (Path(self.tmp.name) / 'private-bodies.jsonl').read_text()
        self.assertNotIn('private-secret', raw)
        self.assertEqual((Path(self.tmp.name) / 'private-bodies.jsonl').stat().st_mode & 0o777, 0o600)

    def test_token_exchange_is_never_captured(self):
        flow = self.flow()
        flow.request.path = '/v1/oauth/token'
        flow.request.content = b'{"refresh_token":"private-secret"}'
        self.module.PRIVATE = True
        self.module.request(flow)
        self.assertEqual(flow.metadata, {})
        self.assertEqual(list(Path(self.tmp.name).iterdir()), [])

    def test_response_capture_is_bounded_but_forwarding_is_not(self):
        flow = self.flow()
        self.module.request(flow)
        self.module.responseheaders(flow)
        chunk = b'x' * (self.module.LIMIT + 5)
        self.assertEqual(flow.response.stream(chunk), chunk)
        self.assertEqual(len(flow.metadata['trace_bytes']), self.module.LIMIT)
        self.module.response(flow)
        record = json.loads((Path(self.tmp.name) / 'flows.jsonl').read_text())
        self.assertTrue(record['capture_truncated'])
        self.assertEqual(record['response_bytes'], len(chunk))


if __name__ == '__main__':
    unittest.main()
