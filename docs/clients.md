# Client cookbook

Config-file snippets for pointing a client at the router, plus the one command that proves it
landed. The [README](../README.md#-pointing-your-client-at-it) carries the short version — the
base URL and the key — and this is the long one, for the clients that read a config file rather
than an environment variable.

Router keys are accepted in both dialects: `Authorization: Bearer mar_live_…` and
`x-api-key: mar_live_…`. Anything that can set a base URL and a key works; what follows is what
the console's own client snippets cover today. There is **no automated integration test against
each of these clients** — treat this as a documented list, not a verified one.

**The console says all of this too, filled in.** Mint or reveal a key and the dialog carries a
**Point your tool at it** panel — tabs for Claude Code, Cursor, Codex CLI, Aider, the OpenAI SDKs
and `curl`, each block already containing this deployment's base URL (`PUBLIC_URL`, else the
console's own origin) and that key's real value. Everything below is the same content for someone
who never opened the console.

Every block uses `http://localhost:8080` and `mar_live_…` — swap in your own.

A base URL and a key make the first request work. Before shipping a workload, also read
[Errors, retries and timeouts](#errors-retries-and-timeouts). The router already fails over
across accounts, so a client that adds its own retry and timeout logic on top can multiply load
or make a failure look like a different kind.

---

## Verify it landed on the router, not the real upstream

Do this before wiring in a real workload. `GET /v1/models` only answers once at least one account
has declared a catalog ([see below](#tell-each-account-what-it-serves)), so a `200` with a list you
recognize — or an empty `data: []` from an undeclared account — is the router. A DNS error, or a
TLS handshake against a provider's real hostname, means the base URL never took:

```bash
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .
```

---

## Environment-variable clients

Claude Code, Aider, and anything else that reads the standard variables:

```bash
# Claude Code, or anything reading the Anthropic env vars
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_AUTH_TOKEN="mar_live_…"

# any OpenAI-compatible client — note the /v1 suffix
export OPENAI_BASE_URL="http://localhost:8080/v1"
export OPENAI_API_KEY="mar_live_…"
```

## Cursor

Settings → Models → **Override OpenAI Base URL** = `https://router.example.com/v1` (the `/v1`
suffix is required — Cursor appends `/chat/completions`), then paste the router key into the
"OpenAI API Key" field. Agent and plan mode route through the override; **tab-autocomplete and
inline-edit stay on Cursor's own backend** and never reach the router.

## Codex CLI

`~/.codex/config.toml`:

```toml
[model_providers.multi_ai_router]
name = "multi-ai-router"
base_url = "http://localhost:8080/v1"
env_key = "MULTI_AI_ROUTER_API_KEY"   # set this env var to your mar_live_… key

[profiles.router]
model_provider = "multi_ai_router"
model = "gpt-5"   # whatever model name the account behind it serves
```

```bash
export MULTI_AI_ROUTER_API_KEY="mar_live_…"
codex --profile router
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer $MULTI_AI_ROUTER_API_KEY" | jq .
```

## Cline / Roo Code

VS Code `settings.json` (or the extension's own settings UI, same fields):

```json
{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "http://localhost:8080/v1",
  "cline.openAiApiKey": "mar_live_…",
  "cline.openAiModelId": "gpt-5"
}
```

```bash
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .
```

## OpenAI SDK — Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="mar_live_…")
resp = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

## OpenAI SDK — Node

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "mar_live_…" });
const resp = await client.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "hello" }],
});
console.log(resp.choices[0].message.content);
```

```bash
# Same verification for both SDKs — the base URL is what changed, not the wire protocol
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq '.data[].id'
```

## LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(base_url="http://localhost:8080/v1", api_key="mar_live_…", model="gpt-5")
print(llm.invoke("hello").content)
```

Anthropic-dialect accounts work the same way through `langchain_anthropic.ChatAnthropic(base_url=...)`
— pick the dialect that matches the account behind the key, or rely on cross-dialect translation
(below) and use whichever `langchain_*` package your chain already imports.

## LiteLLM

Proxy `config.yaml`:

```yaml
model_list:
  - model_name: gpt-5
    litellm_params:
      model: openai/gpt-5        # LiteLLM's own routing prefix, unrelated to the router's dialect
      api_base: http://localhost:8080/v1
      api_key: mar_live_…
```

```bash
litellm --config config.yaml &
curl -s http://localhost:4000/v1/models | jq .   # LiteLLM's own port, proxying through to the router
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .   # the router directly
```

---

## Tell each account what it serves

**If your tool fills a model picker from `GET /v1/models`, this matters.** An account that declares
nothing accepts any model name you send — that is the default and it is not broken — but the router
will not enumerate a catalog it was never given, so the listing comes back empty. Press
**Discover** on the account's row and the router reads the provider's own `/v1/models` and fills it
in; the field is editable by hand too. Nothing refreshes it on a timer, so a provider retiring a
model never silently moves your traffic.

## Model names and dialects

Send whatever model name you normally send. It passes through unchanged unless the selected account
defines an alias map — details in
[`docs/idea/06-protocol-translation.md`](idea/06-protocol-translation.md).

**Cross-dialect translation is live** — an Anthropic-dialect client can reach an OpenAI-dialect
account and back, including streaming and tool calls. The one exception is a request shape that
cannot be translated faithfully (a lossy edge documented in the same file): that fails with a `400`
naming the reason rather than being converted approximately.

Pick the dialect of the account behind the key when you can. A same-dialect request is relayed
byte for byte. A cross-dialect one is translated, and a field with no counterpart in the other
dialect is either refused with a `400` or dropped. Every such field, per dialect pair, is in the
[Known lossy edges](idea/06-protocol-translation.md#known-lossy-edges) table. Check it before
relying on `verbosity`, `cache_control`, sampling parameters or a structured-output constraint
across dialects.

A tool call is never given invented arguments. If a non-streamed upstream answer contains a tool
call whose `arguments` are not a JSON object, you get an error in your dialect with
`translation_protocol_error`, not a `tool_use` with `input: {}`. Absent or blank `arguments` is a
no-argument call and still arrives as `{}`. On a stream, the argument fragments are forwarded as
they arrive, so your own parse of them is where a malformed call shows.

---

## Errors, retries and timeouts

The router walks every eligible account before it answers with an error. A failure that reaches
you has already been tried across the pool. What follows is what the code does today
(`packages/core/src/errors.ts`, `packages/core/src/wall.ts`, `apps/api/src/errors/`,
`apps/api/src/services/dataplane/`).

### Status codes

| Status | `code` | `error.router.wall` | Meaning | Retry? |
|---|---|---|---|---|
| `400` | `invalid_request` (also an unknown `x-router-usage` value), `translation_failed` | `request` | The request is wrong, or cannot be translated faithfully into the account's dialect. Also the answer when two or more accounts in one chain refuse the request itself (e.g. a Claude subscription's "Extra Usage" gate): the request, not the pool, is the problem — never a `429` | No. Change the request |
| `400` | relayed upstream refusal | none | The upstream refused the request. Its own words, relayed | No. A bad request is bad at every account |
| `400` | `context_length_exceeded` (OpenAI shape) / `prompt is too long: …` (Anthropic shape) | none | The prompt does not fit the context window, whatever status the upstream used | Compact the transcript, then retry |
| `401` | `key_revoked` | `human` | Router key revoked, unknown, expired, malformed or missing, or Bearer and `x-api-key` disagree | No. Ask the operator |
| `402` | `credits_exhausted` | `human` | Every account that could serve is out of credits. No clock clears it | **Never automatically.** Alert a human |
| `403` | `scope_violation` | `scope` | The key's scope reaches no account | No. Ask the operator |
| `404` | `model_not_found`, `not_found` | `scope` / `request` | No account in the key's scope serves the requested model (on any inference route or `GET /v1/models/:id`), or an unknown path. Before 2.56.0 an unserved model on an inference route was a `503 no_healthy_account` with wall `scope` | No. Check `GET /v1/models` |
| `413` | `request_too_large` | `request` | Body over `MAX_REQUEST_BODY_BYTES` (32 MiB default) | No. Send less |
| `415` | `unsupported_content_encoding` | `request` | The body is compressed with an encoding the router does not decode | No. Send it uncompressed |
| `429` | `quota_exhausted` | `clock` | Every account that could serve has a spent window. **Always** has `Retry-After`: the earliest reset, or a 30 s floor when the reset is unknown | Yes, after `Retry-After` |
| `429` | `key_rate_limited` | `clock` | **Your key** exceeded its own rate limit. No account is out of anything | Yes, after `Retry-After`. Slow down. Switching to another key on the same router only moves the load |
| `500` | `credential_decrypt_failed` | `human` | A stored credential cannot be read | No. Ask the operator |
| `500` | none | `internal` | Unexpected router failure. The detail is logged, not returned | Once, with backoff |
| `502` | `upstream_auth_failed` | `human` | Every candidate's upstream rejected the router's own credential. Your key is fine | No. The operator re-authenticates an account |
| `502` | `translation_protocol_error` | `internal` | A non-streamed cross-dialect answer could not be translated faithfully (e.g. an upstream tool call whose `arguments` are not a JSON object). Never relayed as a tool call with `input: {}`. `retryable: false` | No automatic retry; the same request usually reproduces it. Report it |
| `503` | `upstream_overloaded` | `clock` | The provider's shared backend is busy. Has `Retry-After` (the upstream's own value, or 30 s) | Yes, after `Retry-After` |
| `503` | `key_verification_unavailable` | `capacity` | Key verification is briefly busy, or the router's database is unreachable and your key has no recently verified copy in memory (a warm key keeps working through a short outage). `Retry-After: 1` | Yes, a bounded number of times |
| `503` | `no_healthy_account` | `capacity`, `human` or `scope` | Nothing in scope can serve. When **every attempt failed on capacity** (overloaded, server error, connection, timeout) it has `Retry-After` (and `error.router.retry_after_s`): the soonest account cooldown, or 30 s when unknown. Other `capacity` endings carry no `Retry-After`. `human` (accounts disabled or needing re-auth) and `scope` (no account serves this operation) never carry one and will not clear on a retry | When `retryable` is `true`: after `Retry-After` if present, else bounded exponential backoff |
| `503` | `router_shutdown`, `request_admission_unavailable` | `capacity` | The router is restarting, or its request admission is closed or full. No `Retry-After` | Yes, after a few seconds with backoff. A restart usually takes seconds |
| `504` | `upstream_timeout` | `capacity` | The upstream was reached and missed its deadline | Yes, with backoff. Prefer streaming for long calls |

Any other `4xx`/`5xx` that an upstream sends and the router relays keeps the upstream's status and
its words, translated into your dialect when the account speaks another one. A relayed error has no
`error.router`, except a Claude subscription's fast-transport refusal, which is rendered as the
router's own `invalid_request` (`wall: request`, `scope: account`). The `x-router-*` headers below still name the account that said it.

During a restart, a request can also fail before it reaches the router, depending on what sits in
front of it: connection refused, or a `502`/`503` from your ingress with no JSON body. Treat these
like `router_shutdown`.

### The error body

Router-authored errors use the dialect you called, with a machine-readable `router` object inside
`error` (inside the member the OpenAI SDKs hand you):

```json
{"type":"error","error":{"type":"rate_limit_error","message":"…","router":{
  "wall":"clock","scope":"pool","retryable":true,
  "reset_at":"2026-11-06T18:00:30.000Z","reset_source":"estimated","retry_after_s":30,
  "accounts":[{"account":"acct_3f2a…","state":"cooling-down","reset_at":"2026-11-06T18:00:30.000Z"}],
  "pools":["coding"],"signal":"cooling-down","attempts":0,"request_id":"9c1e…"}}}
```

The OpenAI dialects use the same object: `{"error":{"message":…,"type":…,"param":null,"code":"quota_exhausted","router":{…}}}`.

| Field | Read it as |
|---|---|
| `wall` | What clears it: `clock` (wait `retry_after_s`), `capacity` (retry later, no instant), `human` (an operator must act), `scope` (another key or model), `request` (change the request), `internal` (router fault) |
| `retryable` | `true` exactly when `wall` is `clock` or `capacity`. **Decide retries on this, not on the status.** |
| `retry_after_s` | Equal to the `Retry-After` header, `null` when there is none |
| `reset_at`, `reset_source` | A `429`'s refill instant and whether it was `provider-reported`, `estimated` or `unknown` |
| `scope` | Who the verdict is about: `pool`, `account`, `session`, `key`, `request`, `router` |
| `accounts`, `pools` | Opaque account references (`acct_…`) and pool names, for the operator |
| `signal` | The machine token that decided it (`anthropic:rate_limit_error`, `cooling-down`, …) |
| `attempts`, `request_id` | Upstream attempts made, and the id to quote to the operator |

Match on `code` and `error.router`, never on the English `message`. The sentences are kept stable
for now, but they are not a contract. The enums can gain values, so parse them tolerantly. An
unknown `wall` or `scope` means "unknown": fall back to the HTTP status and do not reject the
whole body.

### Errors after the stream started

Once the first byte of a stream reaches you, the router cannot fail over. If the upstream then breaks
(connection reset, idle deadline, router shutdown), the stream ends with **one error event and a
clean close**, never a silent truncation (`services/dataplane/relay-stream-end.ts`). In all
three dialects that event carries the same `router` object as an error response, so you can grade
it by `router.wall` and `router.retryable` exactly as you would a status code:

| You called | Last event (`router` is where you read it) |
|---|---|
| `/v1/messages` | `event: error` · `{"type":"error","error":{"type":"api_error","message":…,"router":{…}}}` (`overloaded_error` on shutdown). At `error.router` |
| `/v1/chat/completions` | `data: {"error":{"message":…,"type":"server_error","param":null,"code":<signal>,"router":{…}}}`, then `data: [DONE]`. At `error.router` |
| `/v1/responses` | `event: error` · `{"type":"error","code":<signal>,"message":…,"param":null,"router":{…}}`. Here `router` is at the top level |

`<signal>` is `upstream_error`, `upstream_timeout` or `router_shutdown`. `router.wall` is
`capacity` and `retryable` is `true`, but the partial answer is already in your hands. Retrying
means re-sending the whole turn, with the tokens already spent. An error event that the
**upstream** sent mid-stream is relayed exactly as sent, without `router`.

A wall that the upstream reports inside a `200` *before* any content (a spent plan, a drained
balance) is caught before the router commits the response and fails over like any other error.
If no account is left, you get the real `429`/`402`/`503`, never a `200`.

### Response headers

On every data-plane answer, success or failure, stream or not, before the first byte:

| Header | Value |
|---|---|
| `x-router-request-id` (also `x-request-id`) | The request id. Log it; it is what an operator searches for. Send your own `x-request-id` (`[A-Za-z0-9_.:-]`, ≤128 chars) to correlate your own traces with it |
| `x-router-attempts` | Upstream attempts this request made (`0` when refused before any) |
| `x-router-served-model` | The model the upstream was asked for, after the account's alias map |
| `x-router-provider` | The serving account's provider id |
| `x-router-account` | The serving account, opaque (`acct_…`) |
| `x-router-session-restart` | Set only when a Claude-subscription session had to start fresh on another account (`failover`, or the reason the binding was dropped). Turns the upstream remembered are gone, so resend the full history |

### Retries: let the router do it

- **Set your SDK's own retries to `0` or `1`** (`maxRetries` in the OpenAI, Anthropic and Vercel AI
  SDKs). One request to the router already tries every eligible account. Three SDK retries
  multiplied by several keys on the same router send the same failing request 4×K times, all to a
  pool that already said no.
- **Never retry automatically on `401`, `402`, `403`, `413`, `415`**, or a `502`/`503` whose
  `error.router.retryable` is `false`. They need a different request or a human. A loop on them
  is load, not resilience.
- **On `429` and `upstream_overloaded`, wait `Retry-After`** and add jitter. A `key_rate_limited`
  `429` is about your key. Back off; do not rotate keys.
- **Treat keys on one router as one failure domain.** Moving a `5xx` to a sibling key on the same
  router reaches the same accounts.
- **Failing over to a different provider outside the router** (another gateway, a paid API) is
  your decision. Make it visible: count it, alert on it, and never do it on a `402` or a
  `key_rate_limited` `429`. Doing so silently moves spend and hides the wall from the operator.
- A request that failed **before you received any content** is safe to send again. Inference has
  no side effect beyond the tokens spent. A stream that broke **after** content arrived is a new
  turn if you resend it.

### Timeouts

The router's clocks (operator-configurable; defaults shown, `docs/idea/09-deployment.md`):

| Router clock | Default | What happens |
|---|---|---|
| `UPSTREAM_FIRST_BYTE_TIMEOUT_MS`: streamed attempt, until the upstream's headers | 5 min | Fails over to the next account; you see nothing yet |
| `UPSTREAM_STREAM_WALL_HOLD_MS`: a streamed response is held while its first event is checked for a wall | 5 s | Adds at most this much before your headers. Time to first token is unchanged |
| `UPSTREAM_IDLE_TIMEOUT_MS`: silence between stream chunks | 55 s | The stream ends with the `upstream_timeout` error event above |
| `UPSTREAM_STREAM_TIMEOUT_MS`: one whole streamed attempt | 1 h | Same |
| `UPSTREAM_TIMEOUT_MS`: one whole **non-streamed** attempt (and a Claude-subscription attempt) | 10 min | Fails over to the next account (or `504`) |
| `CLAUDE_SDK_STREAM_IDLE_SECONDS`: a Claude-subscription stream with no event | 90 s | `504`. A quiet subscription stream sends an SSE `: ping` comment every 15 s meanwhile |
| `RECOVERY_REQUEST_WAIT_MS`: wait inside the request for the router's own recovery probe | 5 s | Then served, or the honest `429` |

Each clock bounds **one attempt**. There is no deadline for the whole request: a request that
fails over walks several accounts, each with its own clock. So:

- **Stream long calls.** A non-streamed call shows nothing until the whole answer exists, and
  proxies and idle timers in front of the router cut silent connections. A planner call that
  takes 20 minutes must stream.
- **Streaming:** do not set a short time-to-headers timeout. Headers can wait up to the
  first-byte clock on each attempt. Use an **idle timeout between chunks of at least 70 s**, so
  the router's 55 s clock fires first and you get a typed error instead of a cut socket. Use a
  **total deadline** that suits your workload.
- **Non-streamed:** set the client timeout **above 10 min** (`UPSTREAM_TIMEOUT_MS`) if you want
  the router's own `504` rather than your own abort, or lower if your workload cannot wait that
  long.
- **Cancel by aborting the HTTP request** (`AbortController`, dropping the future, closing the
  connection). The router sees the disconnect, stops the upstream attempt and records the
  request as `client_cancelled`. Walking away from a promise without aborting its fetch keeps an
  upstream turn running, and billed, for nobody.

### Sessions

Send a stable conversation id on every turn: `x-session-id` (also accepted: `anthropic-session-id`,
`x-conversation-id`). The default `sticky` policy keeps one conversation on one account. That keeps
the prompt cache warm and, for Claude subscriptions, the upstream session alive. Without the
header the router guesses from the opening of the conversation, which works less well. A subagent
sends its own id, not its parent's.

### Per-call cost

A translated answer carries the router's estimate in `usage`, since 2.48.0:
`"cost": 1.215, "cost_source": "estimated", "cost_basis": "metered" | "notional"`. On a stream it
is in the final usage frame. A same-dialect answer carries it only if you send
`x-router-usage: cost` (any other value is a `400`). That re-frames the response, so it is no
longer byte-identical. `cost_basis: notional` means a subscription account served the call: the
number is what it **would** have cost on the API, an attribution and not a spend. Label the leg
with `x-router-provider`. The fields are absent, never `0`, when no rate is known. Details:
[`idea/06-protocol-translation.md`](idea/06-protocol-translation.md#per-call-cost-on-the-wire).

### Probes and monitors

- **`GET /v1/models` is the canonical preflight and readiness probe for a client.** It is
  token-free. `200` proves the base URL, the `/v1` prefix and the key, whether or not the list is
  empty. `401` means the key. Use it at boot, in a health check, or before a batch.
- **Never test reachability by POSTing to an inference route**, with `{}` or with a dummy prompt.
  An inference POST is a real request: it is recorded in the operator's usage, `{}` lands there as
  a `400` client error, and a dummy prompt spends quota on a pooled account. A periodic one from a
  restarting process looks like a fault in the router's error rate.
- **Monitor the router** with `GET /readyz`: `503` when Postgres is unreachable or a shutdown has
  begun. `GET /healthz` is liveness only. `GET /` is the console's static page and answers `200`
  while inference is down.

### Per-SDK settings

| Client | Settings |
|---|---|
| Vercel AI SDK (`@ai-sdk/anthropic`, `@ai-sdk/openai`) | `maxRetries: 0` (or `1`) on `generateText`/`streamText`/`generateObject`; pass `abortSignal`; prefer `streamText`/`streamObject` for long calls; read `error.router` from `APICallError.responseBody` (or `.data`) |
| OpenAI SDK (Node / Python) | `maxRetries: 0`/`max_retries=0`; `timeout` above 10 min for non-streamed, or `stream: true`; `err.error.router` (Node) / `err.body["router"]` (Python) |
| Anthropic SDK (Node / Python) | `maxRetries: 0`/`max_retries=0`; `stream` for long calls; the `router` object is in `err.error.error.router` (Node) / `err.body["error"]["router"]` (Python) |
| `reqwest` (Rust) / raw HTTP | No built-in retries. Parse the JSON body on every non-`2xx`; read `Retry-After`; use `read_timeout` (idle) ≥ 70 s rather than a short total `timeout`; on streams, treat a final `error` event as the outcome |

---

## Run the live check

After wiring a client in, run the same six legs the router promises to answer end to end against
the deployed URL — a plain text turn, a forced tool call, `tool_choice: any`, the tool-result round
trip, a streamed forced tool, and reasoning plus a forced tool — plus two informational legs on
`/v1/chat/completions` and `/v1/responses` that an account may legitimately refuse and that never
gate the exit code. The script reads the API key from the named environment variable only; the key
is never accepted as an argument and never printed:

```bash
export MAR_KEY=mar_live_…
bin/smoke --url https://router.example.com --model claude-opus-5 --key-env MAR_KEY
```

The runner exits `0` when every required leg passes, `1` on any required-leg failure, and `2` when
nothing failed but the key was unset, the DNS lookup failed, the request timed out, or every leg
came back inconclusive for one of those reasons. `--json` emits the report as JSON. See
`bin/smoke --help` for every flag.

This is what the rolling live prove (`#178`) drove by hand, and what every new provider add
should run before shipping — `apps/api/test/unit/smoke/grade.test.ts` is the grader's contract;
`apps/api/test/integration/smoke.test.ts` drives the runner end to end against a mocked upstream.

---

## Read next

| Doc | Covers |
|---|---|
| [`idea/04-api-keys-and-access.md`](idea/04-api-keys-and-access.md) | Minting keys, scope, what a `401` means |
| [`KEYS.md`](KEYS.md#errors-a-key-holder-sees) | The key holder's view of `401`/`402`/`403`/`429`/`503` |
| [`idea/05-routing-and-failover.md`](idea/05-routing-and-failover.md#which-failure-the-client-hears) | Failover, which failure the client hears, upstream deadlines |
| [`idea/06-protocol-translation.md`](idea/06-protocol-translation.md) | Ingress × egress matrix, streaming, tool calls, aliases |
| [`idea/09-deployment.md#troubleshooting`](idea/09-deployment.md#troubleshooting) | Symptom → cause → fix, including client-side `401`s |
