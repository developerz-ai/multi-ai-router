"""Observe streaming wire traffic. Never persist authentication headers or token exchanges."""
import base64
import json
import os
import re
import time
from pathlib import Path
from mitmproxy import http
from mitmproxy.net import encoding

ROOT = Path(os.environ['CLAUDE_TRACE_DIR'])
PRIVATE = os.environ.get('CLAUDE_TRACE_PRIVATE') == '1'
SAFE_HEADERS = {'accept', 'content-type', 'user-agent', 'anthropic-version',
                'anthropic-beta', 'x-app', 'anthropic-dangerous-direct-browser-access'}
SAFE_VALUES = {'type', 'role', 'model', 'stop_reason', 'stop_sequence', 'ttl', 'scope',
               'effort', 'display', 'keep', 'service_tier', 'speed', 'status', 'clear_at'}
LIMIT = 2 * 1024 * 1024
IDENTITIES = {}


def identity(value):
    if value not in IDENTITIES:
        IDENTITIES[value] = f"<id:{len(IDENTITIES) + 1}>"
    return IDENTITIES[value]


def append(name, value):
    fd = os.open(ROOT / name, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, 'a') as output:
        output.write(json.dumps(value, ensure_ascii=True) + '\n')


def billing(text):
    # Retain field names and enums; hide all request, prompt, workload and session identifiers.
    allowed = {'cc_version', 'cc_entrypoint', 'cch', 'cc_turn_origin',
               'cc_prompt_index', 'cc_turn_index', 'cc_is_subagent'}
    return 'x-anthropic-billing-header: ' + ' '.join(
        f'{key}={value if key in allowed else identity(value)};'
        for key, value in re.findall(r'([a-z_]+)=([^;]+);', text))


def shape(value, key=''):
    if isinstance(value, dict):
        return {name: shape(nested, name) for name, nested in value.items()}
    if isinstance(value, list):
        return [shape(nested, key) for nested in value]
    if isinstance(value, str):
        if key == 'text' and value.startswith('x-anthropic-billing-header:'):
            return billing(value)
        if key == 'user_id':
            try:
                nested = json.loads(value)
                if isinstance(nested, dict):
                    return {name: identity(str(nested[name])) for name in nested}
            except (ValueError, TypeError):
                pass
        if key in {'id', 'tool_use_id', 'parent_tool_use_id', 'previous_message_id'}:
            return identity(value)
        if key in SAFE_VALUES:
            return value
        return f'<redacted: {len(value)} chars>'
    return value


def request(flow: http.HTTPFlow):
    if flow.request.host != 'api.anthropic.com':
        return
    path = flow.request.path.split('?', 1)[0]
    if path != '/v1/messages' and not (flow.request.method == 'GET' and path == '/api/oauth/usage'):
        return
    headers = {name.lower(): value if name.lower() in SAFE_HEADERS or
               name.lower().startswith('x-stainless-') else identity(value) if name.lower() in {'x-claude-code-session-id', 'x-claude-code-prompt-id', 'x-client-request-id'} else '<redacted>'
               for name, value in flow.request.headers.items()}
    raw = flow.request.content or b''
    try:
        body = shape(json.loads(raw)) if raw else None
    except (ValueError, UnicodeError):
        body = {'unparsed_bytes': len(raw)}
    flow.metadata['trace'] = {'method': flow.request.method,
        'path': path, 'beta_query': flow.request.query.get('beta') == 'true',
        'http_version': flow.request.http_version, 'headers': headers, 'body': body,
        'started_at': time.time(), 'request_bytes': len(raw)}
    if PRIVATE and path == '/v1/messages':
        # Exact body bytes for checksum work, no headers. Still contains prompts and identifiers.
        append('private-bodies.jsonl', {'body_base64': base64.b64encode(raw).decode()})


def responseheaders(flow: http.HTTPFlow):
    record = flow.metadata.get('trace')
    if record is None:
        return
    record['status'] = flow.response.status_code
    record['response_headers'] = {name.lower(): value for name, value in
        flow.response.headers.items() if name.lower().startswith('anthropic-ratelimit-')
        or name.lower() in {'content-type', 'retry-after', 'content-encoding'}}
    record['response_http_version'] = flow.response.http_version
    record['headers_after_ms'] = round((time.time() - record['started_at']) * 1000, 3)
    flow.metadata['trace_bytes'] = bytearray()
    record['response_bytes'] = 0
    record['chunks'] = 0

    def observe(chunk):
        record['response_bytes'] += len(chunk)
        if chunk:
            record['chunks'] += 1
            if 'first_chunk_after_ms' not in record:
                record['first_chunk_after_ms'] = round((time.time() - record['started_at']) * 1000, 3)
        collected = flow.metadata['trace_bytes']
        collected.extend(chunk[:max(0, LIMIT - len(collected))])
        return chunk  # Forward immediately, unchanged. No full-response buffering.

    flow.response.stream = observe


def response(flow: http.HTTPFlow):
    record = flow.metadata.get('trace')
    if record is None:
        return
    raw = bytes(flow.metadata.get('trace_bytes', b''))
    try:
        raw = encoding.decode(raw, flow.response.headers.get('content-encoding', 'identity')) or b''
    except Exception:
        record['response_decode_error'] = True
        raw = b''
    events = []
    try:
        if 'text/event-stream' in flow.response.headers.get('content-type', ''):
            for line in raw.decode('utf8', errors='replace').splitlines():
                if line.startswith('data: '):
                    try:
                        events.append(shape(json.loads(line[6:])))
                    except ValueError:
                        pass
            record['events'] = events
        else:
            record['response_body'] = shape(json.loads(raw))
    except (ValueError, UnicodeError):
        record['response_unparsed_bytes'] = len(raw)
    record['capture_truncated'] = record.get('response_bytes', 0) > LIMIT
    record['total_ms'] = round((time.time() - record['started_at']) * 1000, 3)
    append('flows.jsonl', record)


def error(flow: http.HTTPFlow):
    record = flow.metadata.get('trace')
    if record is not None:
        record['transport_error'] = True  # Upstream error prose can contain private values.
        append('flows.jsonl', record)
