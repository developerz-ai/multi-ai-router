"""Bounded, streaming OpenCode capture. Never write real authentication material."""
import base64
import json
import os
import time
from pathlib import Path

from mitmproxy import http
from mitmproxy.net import encoding

ROOT = Path(os.environ["OPENCODE_TRACE_DIR"])
LIMIT = 2 * 1024 * 1024
IDS = {}


def identity(value):
    if value not in IDS:
        IDS[value] = f"<id:{len(IDS) + 1}>"
    return IDS[value]


def shape(value, key=""):
    if isinstance(value, dict):
        return {name: shape(item, name) for name, item in value.items()}
    if isinstance(value, list):
        return [shape(item, key) for item in value]
    if isinstance(value, str):
        if key in {"model", "role", "type", "finish_reason", "reasoning_effort", "name"}:
            return value
        if key in {"id", "tool_call_id", "prompt_cache_key"}:
            return identity(value)
        return f"<redacted: {len(value)} chars>"
    return value


def append(name, value):
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a") as output:
        output.write(json.dumps(value) + "\n")


def request(flow: http.HTTPFlow):
    path = flow.request.path.split("?", 1)[0]
    inference = path.endswith(("/chat/completions", "/messages", "/responses", "/models"))
    device = path in {"/console/auth/device/code", "/console/auth/device/token"}
    if flow.request.host != "opencode.ai" or not (inference or device):
        return
    headers = {}
    for name, value in flow.request.headers.items():
        name = name.lower()
        if name == "authorization":
            headers[name] = "Bearer public" if value == "Bearer public" else "<redacted>"
        elif name in {"user-agent", "accept", "content-type", "accept-encoding", "x-opencode-client", "anthropic-version", "anthropic-beta"}:
            headers[name] = value
        elif name.startswith("x-opencode-") or name in {"x-org-id", "x-session-id", "x-session-affinity", "x-parent-session-id"}:
            headers[name] = identity(value)
        else:
            headers[name] = "<redacted>"
    raw = flow.request.content or b""
    try:
        body = shape(json.loads(raw)) if raw else None
    except (ValueError, UnicodeError):
        body = {"unparsed_bytes": len(raw)}
    flow.metadata["trace"] = {"method": flow.request.method, "host": flow.request.host,
        "path": path, "http_version": flow.request.http_version, "headers": headers,
        "body": body, "request_bytes": len(raw), "started_at": time.time()}
    if os.environ.get("OPENCODE_TRACE_PRIVATE") == "1" and raw and inference:
        append("private-bodies.jsonl", {"path": path, "body_base64": base64.b64encode(raw).decode()})


def responseheaders(flow: http.HTTPFlow):
    record = flow.metadata.get("trace")
    if record is None:
        return
    record["status"] = flow.response.status_code
    record["response_headers"] = {name.lower(): value for name, value in flow.response.headers.items()
        if name.lower() in {"content-type", "content-encoding", "retry-after"} or name.lower().startswith("x-ratelimit-")}
    record["headers_after_ms"] = round((time.time() - record["started_at"]) * 1000, 3)
    record["response_bytes"] = 0
    record["chunks"] = 0
    flow.metadata["trace_bytes"] = bytearray()

    def observe(chunk):
        record["response_bytes"] += len(chunk)
        if chunk:
            record["chunks"] += 1
        collected = flow.metadata["trace_bytes"]
        collected.extend(chunk[:max(0, LIMIT - len(collected))])
        return chunk

    flow.response.stream = observe


def response(flow: http.HTTPFlow):
    record = flow.metadata.get("trace")
    if record is None:
        return
    raw = bytes(flow.metadata.get("trace_bytes", b""))
    try:
        raw = encoding.decode(raw, flow.response.headers.get("content-encoding", "identity")) or b""
        if "text/event-stream" in flow.response.headers.get("content-type", ""):
            events = []
            for line in raw.decode("utf8", errors="replace").splitlines():
                if line.startswith("data: ") and line[6:] != "[DONE]":
                    try:
                        events.append(shape(json.loads(line[6:])))
                    except ValueError:
                        pass
            record["events"] = events
            record["done"] = b"data: [DONE]" in raw
        else:
            record["response_body"] = shape(json.loads(raw))
    except Exception:
        record["response_unparsed_bytes"] = len(raw)
    record["capture_truncated"] = record["response_bytes"] > LIMIT
    record["total_ms"] = round((time.time() - record["started_at"]) * 1000, 3)
    append("flows.jsonl", record)


def error(flow: http.HTTPFlow):
    record = flow.metadata.get("trace")
    if record is not None:
        record["transport_error"] = True
        append("flows.jsonl", record)
