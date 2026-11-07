import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest

sys.dont_write_bytecode = True
sys.modules["mitmproxy"] = types.SimpleNamespace(http=types.SimpleNamespace(HTTPFlow=object))
sys.modules["mitmproxy.net"] = types.SimpleNamespace(encoding=types.SimpleNamespace(decode=lambda data, _: data))


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        os.environ["OPENCODE_TRACE_DIR"] = self.tmp.name
        os.environ.pop("OPENCODE_TRACE_PRIVATE", None)
        spec = importlib.util.spec_from_file_location("capture", Path(__file__).with_name("capture.py"))
        self.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.module)

    def tearDown(self):
        self.tmp.cleanup()

    def flow(self, path="/inference/openai/v1/chat/completions"):
        return types.SimpleNamespace(metadata={}, request=types.SimpleNamespace(
            host="opencode.ai", path=path, method="POST", http_version="HTTP/1.1",
            headers={"authorization": "Bearer SECRET", "x-opencode-org-id": "PRIVATE-ORG",
                "x-opencode-session": "PRIVATE-ID", "x-session-id": "PRIVATE-ID",
                "user-agent": "opencode/latest/2.2.5/cli", "cookie": "SECRET"},
            content=json.dumps({"model": "big-pickle", "messages": [{"role": "user", "content": "PRIVATE-PROMPT"}]}).encode()),
            response=types.SimpleNamespace(status_code=200,
                headers={"content-type": "text/event-stream", "set-cookie": "SECRET"}))

    def test_stream_is_unchanged_and_private_fields_never_escape(self):
        flow = self.flow()
        self.module.request(flow)
        self.module.responseheaders(flow)
        chunks = [b'data: {"choices":[{"delta":{"content":"PRIVATE-REPLY"}}]}\n\n',
                  b'data: {"usage":{"prompt_tokens":42}}\n\ndata: [DONE]\n\n']
        for chunk in chunks:
            self.assertIs(flow.response.stream(chunk), chunk)
        self.module.response(flow)
        path = Path(self.tmp.name) / "flows.jsonl"
        text = path.read_text()
        for secret in ["SECRET", "PRIVATE-ORG", "PRIVATE-ID", "PRIVATE-PROMPT", "PRIVATE-REPLY"]:
            self.assertNotIn(secret, text)
        record = json.loads(text)
        self.assertEqual(record["headers"]["x-session-id"], record["headers"]["x-opencode-session"])
        self.assertEqual(record["events"][1]["usage"]["prompt_tokens"], 42)
        self.assertTrue(record["done"])
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_public_token_is_recognized_and_analysis_copy_is_bounded(self):
        flow = self.flow()
        flow.request.headers["authorization"] = "Bearer public"
        self.module.request(flow)
        self.module.responseheaders(flow)
        chunk = b"a" * (self.module.LIMIT + 1)
        self.assertIs(flow.response.stream(chunk), chunk)
        self.module.response(flow)
        record = json.loads((Path(self.tmp.name) / "flows.jsonl").read_text())
        self.assertTrue(record["capture_truncated"])
        self.assertEqual(len(flow.metadata["trace_bytes"]), self.module.LIMIT)
        self.assertEqual(record["headers"]["authorization"], "Bearer public")

    def test_device_and_refresh_payloads_never_enter_private_wire(self):
        os.environ["OPENCODE_TRACE_PRIVATE"] = "1"
        for path in ["/console/auth/device/code", "/console/auth/device/token"]:
            flow = self.flow(path)
            flow.request.content = b'{"refresh_token":"SECRET","device_code":"SECRET"}'
            flow.response.headers["content-type"] = "application/json"
            self.module.request(flow)
            self.module.responseheaders(flow)
            flow.response.stream(b'{"access_token":"SECRET","refresh_token":"SECRET"}')
            self.module.response(flow)
        self.assertFalse((Path(self.tmp.name) / "private-bodies.jsonl").exists())
        self.assertNotIn("SECRET", (Path(self.tmp.name) / "flows.jsonl").read_text())
        other = self.flow("/console/api/user")
        self.module.request(other)
        self.assertNotIn("trace", other.metadata)
        other = self.flow()
        other.request.host = "unrelated.example"
        self.module.request(other)
        self.assertNotIn("trace", other.metadata)


if __name__ == "__main__":
    unittest.main()
