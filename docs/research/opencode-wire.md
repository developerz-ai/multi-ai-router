# OpenCode 2.2.5 wire research

Observed 2026-11-07 with the installed native `opencode v2.2.5`, pinned mitmproxy
12.2.3 on loopback, and process-local CA trust. TLS verification remained enabled.
Source cross-check: local upstream checkout `fe04656465` (2026-11-03),
`packages/core/src/plugin/provider/opencode.ts`, `console-access.ts` and
`session/model-request.ts`. Source facts below are distinguished from captured traffic.

## Captured inference

Three isolated standalone CLI runs requested `TRACE_42`, with all tool permissions denied:

| Identity | Explicit model | Endpoint | Result |
|---|---|---|---|
| Anonymous | `opencode/big-pickle` | `/inference/openai/v1/chat/completions` | 429 `FreeUsageLimitError` |
| Anonymous | `opencode/deepseek-v4.1-flash-free` | same | 429 `FreeUsageLimitError` |
| Existing selected Console OAuth login | `opencode/big-pickle` | same | 429 `FreeUsageLimitError` |

The first response stated `Retry-After: 38871`. These observations establish request shape
and the quota refusal, **not successful inference, tool round trips or cache behavior**.
Changing login does not establish additional free quota. No egress or identity rotation was used.

All three requests used HTTP/1.1, JSON, `stream: true`,
`stream_options: {include_usage: true}` and `max_completion_tokens: 32000`.
The captured SDK generated one tool definition even with all permissions denied.
The anonymous key was the literal public token, `Authorization: Bearer public`.
The authenticated run substituted its OAuth access token and added `x-opencode-org-id`.

Native headers included:

- `user-agent: opencode/latest/2.2.5/cli`
- `x-opencode-client: cli`
- `x-opencode-project`: project identity
- `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`, `x-session-id`:
  identical session values in each captured top-level turn
- `b3`, `traceparent`: tracing context
- `accept: */*`, `accept-encoding: gzip, deflate, br, zstd`

Only the OAuth run carried `x-opencode-org-id`. The source uses the root/parent session
for affinity in nested sessions; that relationship has not been captured here.

A direct request with the same free model and session, public token and honest
`user-agent: developerz.ai` also returned the typed 429 with `Retry-After`.
The catalog at `/inference/openai/v1/models` returned 200 with the public bearer,
router user agent and session header: 81 models, including Big Pickle (200,000 context /
32,000 output) and DeepSeek V4.1 Flash Free (200,000 / 32,000). The latter stated reasoning
toggle and `low`, `high`, `max` effort. Unauthenticated catalog requests returned 403.
This does not prove successful inference with the router user agent.

## Captured login and source-verified refresh

`opencode auth login opencode --method device --standalone` sent:

1. `POST https://opencode.ai/console/auth/device/code`, JSON
   `{client_id: "opencode-cli", supports_org_scope: true}`. Response 200:
   `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`,
   `expires_in: 600`, `interval: 5`.
2. At five-second intervals, `POST /console/auth/device/token`, JSON
   `{grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}`.
   Two unapproved polls returned 400. Source identifies `authorization_pending`
   as pending and `slow_down` as an instruction to increase the interval.

The diagnostic stopped before browser approval. No successful fresh device exchange or
refresh was captured. The existing selected login's stored credential was OAuth, method
`device`, with an access token, refresh token, expiry and workspace metadata. Its credentials
were copied through a pipe into an isolated client store; the original was not changed.

Source specifies that approved device polls return `access_token`, `refresh_token`,
`expires_in` and optional `org_id` directly. There is no subsequent authorization-code
exchange. Refresh posts JSON to the same token endpoint with
`{grant_type: "refresh_token", refresh_token, client_id: "opencode-cli"}` and persists
rotated tokens. Source's Console management calls use `x-org-id`; **inference uses
`x-opencode-org-id`**, as captured. These names must not be interchanged.

## Router behavior and review

`opencode-oauth` is a separate Console login provider on the captured Chat Completions
surface. Other client dialects use the existing translator. An operator selects Connect,
enters the displayed code at `https://opencode.ai/console/device`, and the existing console
status polling advances the flow. Directly issued tokens use the same consumed-attempt and
lifecycle fences, encrypted credential writer, audit and refresh scheduler as Codex login.
The pending attempt expires at the earlier of the issuer's expiry and the router's configured
TTL. A new login without a workspace id is refused rather than silently selecting one;
refresh retains the previous workspace when the issuer omits it.

The router sends its own user agent and its existing opaque `x-opencode-session` conversation
id. Native client telemetry is documented above, not forwarded from arbitrary callers.
An upstream free limit is a timed cooldown; overload is retried without cooling the account.
Model names are preserved. Paid Console models can be billed by OpenCode; no automatic
substitution from a free model is performed. Console usage has no shipped price table.

The existing `opencode-go` driver remains the separate personal-API-key Go lane, including
its three previously verified surfaces and advisory usage endpoint. Review found no reason
to replace Go API-key auth with Console OAuth. Both share the catalog parser for sizes and
thinking modes. Existing Go session, overload and catalog regression tests remain applicable.

## Reproduce

```sh
bin/opencode-trace --model opencode/big-pickle --private-wire
bin/opencode-trace --model opencode/deepseek-v4.1-flash-free --private-wire
bin/opencode-trace --model opencode/big-pickle --account dz --private-wire
bin/opencode-trace --model opencode/big-pickle --login-probe
```

The explicit account label must identify one saved OAuth login with more than five minutes
remaining; the tool refuses cloned refresh. Account labels vary by operator. It never exports
other providers. CLI stores, prompts and private bodies stay under gitignored
`tmp/opencode-http/runs/<timestamp>/`, directory mode 0700 / file mode 0600.
Manifests pin the actual binary SHA-256 and version for each run. `flows.jsonl` redacts real
credentials and identifiers; `--private-wire` stores exact **inference bodies only**, never
token-exchange bodies or auth headers. Private files must not be uploaded or committed.
Each captured response chunk is forwarded unchanged with a bounded analysis copy. These
proxy measurements are not production latency benchmarks. A quota refusal makes the inference
diagnostic exit nonzero even when the client itself exits zero after emitting an error event.
