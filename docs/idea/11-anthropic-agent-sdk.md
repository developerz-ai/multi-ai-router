# 11 — Claude subscriptions via the Claude Agent SDK

Status: **nothing here is built.** `anthropic-oauth` is in the provider registry with a recorded
reason and no driver, and a request routed to such an Account is refused by name in
`services/dataplane/egress/mode.ts` rather than served some other way. This page is the contract
M4 must satisfy.

How `anthropic-oauth` Accounts (Claude Max/Pro subscriptions) are served. Extracted from
[Meridian](https://github.com/rynfar/meridian), a working single-user proxy on this exact path;
files are cited as `tmp/meridian/src/proxy/x.ts` so every claim is checkable. Meridian's vocabulary
is *profile*; ours is **Account** — close, not identical (§10).

See also [03-providers.md](03-providers.md), [05-routing-and-failover.md](05-routing-and-failover.md),
[06-protocol-translation.md](06-protocol-translation.md).

---

## 1. Why the SDK path

Requests to a Claude subscription Account go through `@anthropic-ai/claude-agent-sdk`'s `query()` —
the documented, first-party programmatic entry point. **No OAuth token is extracted, no request is
forged against `api.anthropic.com` with a borrowed subscription token, no binary is patched.**
Anthropic keeps control of authentication, prompt caching, context management, compaction, and rate
limiting because we depend on their mechanisms rather than routing around them.

The reason is account survival: the product only works if a team's subscriptions keep working, and
injecting subscription OAuth tokens into raw HTTP is the fast path to a banned account.

**The decision is closed. The costs are listed so nobody re-opens it.**

| Cost | What it means | Evidence |
|---|---|---|
| Subprocess per request | Every `query()` spawns `node` running the `claude` CLI (a ~200 MB native binary). A process, not a socket | `query.ts:252` |
| Concurrency is memory-bound | A semaphore, not a connection pool. Meridian defaults to 10 in flight, queues the rest | `server.ts:599-623` |
| The `claude` CLI ships in the image | Plus a libc-matching native binary and a PATH shim (§9) | `Dockerfile` |
| Protocol re-synthesis | The SDK yields its own message objects; responses are **rebuilt**, not relayed — even same-dialect | §6 |
| Tool handling dominates | ~40–45 % of request-path code is tool-related, most of it forcing an autonomous agent loop to behave as a single-turn endpoint | §7 |
| No passthrough fast path | The zero-loss "same dialect → forward bytes" shortcut in [06](06-protocol-translation.md) does not exist here | §6 |
| Sampling knobs are inert | `temperature`, `top_p`, `max_tokens`, `stop`, `seed`, `n`, `logprobs` have no `query()` equivalent — accepted and ignored | §6 |

Anthropic **API-key** Accounts are unaffected: plain HTTP with an API key is ordinary sanctioned
usage and keeps the normal driver. Only *subscription* Accounts take this path.

---

## 2. How a request flows

```
client (Claude Code / OpenCode / Cline / …) ─ POST /v1/messages + mar_live_… ─┐
                                                                             ▼
 ingress: key auth → key scope ∩ Pool → policy → Account       (doc 05)
                                            │  provider == anthropic-oauth
                                            ▼
 1 client detect · 2 Session resolve (header | fingerprint)
 3 lineage verify (continuation|compaction|undo|diverged) · 4 prompt · 5 tools
                                            │  concurrency semaphore
                                            ▼
 query({ prompt, options })
   env: CLAUDE_CONFIG_DIR = <this Account's dir>        ← the whole trick
   spawn node → claude CLI subprocess → Anthropic
                                            │  async-iterable of SDK messages
                                            ▼
 re-synthesis → Anthropic SSE (or OpenAI chunks)
   + block-index remap · tool-name un-prefixing · block filtering
   + rate_limit_event → Account quota state (never forwarded)
   + result.usage → UsageRecord
                                            ▼
 SSE to client · Session mapping persisted · circuit breaker updated
```

Walkthrough, grounded in `server.ts` (`handleMessages`, from :625):

1. **Admission** — request id, then a FIFO semaphore (`server.ts:602`); queue wait measured.
2. **Abort wiring** — one `AbortController` per request, linked to the HTTP signal, passed as `options.abortController` (`query.ts:259`).
3. **Validation** — non-empty messages; Anthropic *server* tools rejected `400`, the SDK cannot produce them (`tools.ts:63-98`).
4. **Account selection** — ours: Pool ∩ key scope → policy. Meridian's: profile resolution (`profiles.ts:181`) + optional priority failover (`server.ts:543`).
5. **Env assembly** — inherited `ANTHROPIC_*` credentials stripped (`server.ts:767-782`).
6. **Session + lineage** (§4) → `resume` / `forkSession` / `resumeSessionAt`, or nothing.
7. **Prompt** — verified resume sends only the *delta*; divergence sends a framed flat replay.
8. **Tool plan** (§7) — blocklists, in-process MCP registration, `PreToolUse` hook.
9. **`query()`** — `includePartialMessages: true` when streaming.
10. **Stream** — discriminate on `message.type`, re-synthesize (§6). The retry ladder applies **only before any byte reaches the client** (`server.ts:2333`).
11. **Finalize** — persist the Session mapping, write the `UsageRecord`, emit terminal frames.

---

## 3. Multi-account via config directories — the crux

`CLAUDE_CONFIG_DIR` tells the `claude` CLI where *its own state and credentials* live. Point two
subprocesses at two directories and you have two accounts in one container with no shared state.
**That is the entire mechanism.** The router never reads, decrypts, refreshes, or attaches a
subscription token; it sets one environment variable.

| Lives in an Account's config dir | Notes |
|---|---|
| `.credentials.json` | OAuth access + refresh token, `expiresAt`, scopes, `subscriptionType`. **Linux/container only.** Must be **compact** JSON — the CLI's parser reads pretty-printed JSON as "logged out" (`tokenRefresh.ts:89`) |
| CLI settings | per-account `settings.json` and friends |
| Session transcripts | what `resume: <sdkSessionId>` reads |

### Traps, all load-bearing

| Trap | Rule |
|---|---|
| **macOS Keychain** | On macOS credentials live in the Keychain, not on disk; service name is `Claude Code-credentials` for the default `~/.claude` and `Claude Code-credentials-<sha256(abspath)[0:8]>` otherwise (`tokenRefresh.ts:42-47`). Mounting a dir from a macOS host carries **no credentials**. Our container is Linux, but host tooling must know |
| **Never set `CLAUDE_CONFIG_DIR=$HOME/.claude`** | Setting it *even to the default value* changes the Keychain lookup key and breaks OAuth (Meridian #453 / claude-code#20553). To use the default, **unset** it (`query.ts:27-33`) |
| **Token-based Accounts still need a pinned dir** | With `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) an isolated dir is still required, or the SDK's 401-recovery silently falls back to host credentials and masks the failure (`profiles.ts:217-227`). That dir holds SDK state only, never the credential |
| **`settingSources` must be explicitly `[]`** | Omitting it makes the CLI load user + project + local settings and slurp the **router host's** `CLAUDE.md` into the system prompt (`query.ts:296-302`) — a **cross-tenant context leak** for us |
| **Env leakage** | Strip `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` before spawning, or the subprocess can loop back through our own router |
| **Root** | The SDK refuses permission-skipping as root unless `IS_SANDBOX=1` (`query.ts:335`). Prefer a real UID |

### Credential lifecycle per Account

| Operation | How |
|---|---|
| Connect | Drive the `claude` CLI's own login against the Account's dir. Headless: build a PKCE authorize URL, take the pasted `code#state`, exchange, write `.credentials.json` into that dir (`profileCli.ts:159-227`) — the two capture modes [03-providers.md](03-providers.md) already specifies |
| Health probe | `claude auth status` with the dir set returns JSON `{loggedIn, email, subscriptionType}` (`profileCli.ts:133-157`) — cheap, first-party, no token handling |
| Refresh | **Not ours.** The SDK / `claude` CLI refreshes inside the config directory. The router does **not** schedule, mint, or write subscription tokens — see the box below |
| Reconnect | Re-run login against the **same** directory: Account id, Pool membership, and usage history survive |
| Delete | Remove the directory with the Account row |

> **Credential refresh for subscription Accounts is not ours to do.** Meridian implements its own
> refresh loop — proactive expiry timers, a background scheduler, direct `.credentials.json` writes
> (`tokenRefresh.ts`). **We do not.** The SDK owns those credentials inside the per-Account
> `CLAUDE_CONFIG_DIR`; our only job is to notice an auth failure from the SDK and move the Account
> to `needs_reauth`, dropping it from routing until an operator reconnects. `tokenRefresh.ts`
> remains useful only as *background on how the credential files are shaped* (compact JSON, the
> Keychain naming rule) — never as an implementation to port. This is a **skip**, not a copy;
> anyone reimplementing it has misread the design.

### Container layout

The `claude` CLI, its config directories, and the router share one container; PostgreSQL is a
separate service ([09-deployment.md](09-deployment.md)). One directory per Account, keyed by
Account id (stable; a label is not):

```
/data/accounts/           ← named volume, mounted into the router container
  acc_01H…/               ← CLAUDE_CONFIG_DIR for "claude-max-seb"
  acc_01J…/               ← CLAUDE_CONFIG_DIR for "claude-max-team-2"
```

- **N subscriptions, one container.** No per-account container. Meridian confirms the shape with
  `MERIDIAN_PROFILES` plus one mount per profile (`docs/deployment.md:126-140`).
- Those directories are **live credential material** — same handling rules as encrypted
  `authMaterial` in [07-security.md](07-security.md), though the CLI owns their format. They are
  the one piece of Account state that does *not* live in Postgres, which makes the volume a backup
  and restore concern in its own right.
- They grow (transcripts). Retention is **DEFERRED** — note it beside the other sweeps in
  [09-deployment.md](09-deployment.md).
- Adding an Account must not need a restart; Accounts resolve from Postgres per request anyway.

---

## 4. Session management

**Why a naive proxy breaks.** The Messages API is stateless — the client resends everything each
turn. The SDK is *stateful* — it owns the conversation, and you either `resume` the right SDK
session id or re-send the whole history as flat text. Getting it wrong means a cold prompt cache
every turn (Meridian measured ~3× TTFB and ~3× tokens for one analogous cache-invalidating change,
`betas.ts:11-14`), and flattened tool history teaches the model to fabricate tool syntax and
self-play transcripts (`messages.ts:97-113`).

| Cache | Key | Used for |
|---|---|---|
| Session cache | client session header, **scoped by Account** | Clients that send one |
| Fingerprint cache | `sha256(clientCwd + "\n" + firstUserText[0:2000])[0:16]`, **scoped by Account** | Headerless clients |

Both are LRU with **coordinated eviction** — evicting from one removes every entry in the other
pointing at the same SDK session id (`session/cache.ts:43-69`); otherwise a half-evicted pair
resurrects a session the other cache abandoned. The fingerprint seed includes the working directory
(unrelated projects routinely open with the same first message) and excludes the system prompt (it
carries per-request file trees that change every turn). Meridian scopes by profile; **we must scope
by Account id** — resuming against the wrong Account is both a cache miss and a leak of one
subscription's conversation into another's.

### Lineage classification

Every request re-verifies the incoming messages are a legal descendant of what we stored: fast path
is one aggregate prefix hash, slow path is per-message hashes with prefix/suffix overlap
(`session/lineage.ts:214`).

| Class | Condition | Action | Why it exists |
|---|---|---|---|
| **continuation** | prefix hash matches and the conversation grew | `resume`, send delta only | The common case. Without it every turn is a full replay |
| **modified continuation** | partial prefix overlap **and** growth | `resume`, restate hashes | Clients mutate earlier messages harmlessly (`cache_control`). Without it these read as divergence |
| **compaction** | contiguous stored **suffix** found after position 0, minimum length | `resume` | The client summarized its own history. Without it a compaction abandons a warm session |
| **undo** | prefix preserved, suffix gone, conversation **shrank** | `forkSession` + `resumeSessionAt: <uuid>` | User edited/retried a turn. Without it the model answers a question that no longer exists |
| **diverged** | no meaningful overlap | drop mapping, start fresh | Correctness backstop |
| **replay / retry** | prefix matches but no growth | treat as diverged | An identical resend would otherwise resume and re-send the last user message, accumulating ghost context (`lineage.ts:232`) |

Undo needs per-message SDK assistant UUIDs stored beside the hashes to name the rollback point.
Compaction needs *positional* overlap, not set membership — Meridian regressed twice on duplicate
messages matching at unrelated positions (`lineage.ts:110-174`).

**Never resume** (`server.ts:940-980`): a headerless request whose last message is a `tool_result`
(a client running its own tool loop — concurrent loops share a fingerprint and would resume each
other); requests marked as a fork or subagent child; anything after the SDK reports the session gone.

### For us

- `Session → (Account, sdkSessionId, lineage state)` is a new obligation on an entity
  [02-domain-model.md](02-domain-model.md) already has.
- **Sticky routing becomes correctness, not optimization.** An SDK session id is only resumable on
  the Account that created it; a policy that moves a Session must invalidate the mapping, not carry it.
- Meridian persists mappings in a JSON file guarded by advisory **lock files** — a scheme that exists
  only because a JSON file has no cross-process coordination. We have **PostgreSQL**: the mapping is
  a real table with real transactions, the in-memory LRU pair sits in front of it, and any sweep that
  touches it takes a `pg_try_advisory_lock` so exactly one replica runs it
  ([09-deployment.md](09-deployment.md)). Their hardest storage problem is a primitive we get for free.
- Meridian applies **no time-based expiry** to the mapping (SDK sessions live for weeks upstream;
  dropping it forces a destructive replay). The 24 h idle-session sweep in
  [09-deployment.md](09-deployment.md) needs re-examination for *this* table specifically (§11).
- Coordinated LRU eviction is **per process and in-memory** — it is a cache invariant, not a job.
  Nothing about it is scheduled or brokered; the durable mapping in Postgres is the shared truth,
  and a cold replica simply re-reads it.

---

## 5. Quota and rate-limit signals

The SDK emits `rate_limit_event` messages in the query stream. They are **never forwarded to the
client** — they are Account state (`rateLimitStore.ts`).

| Field | Meaning | Feeds |
|---|---|---|
| `status` | `allowed` \| `allowed_warning` \| `rejected` | circuit breaker |
| `rateLimitType` | which window | bucket key |
| `resetsAt` | epoch ms, when the window refills | `cooling_down` until |
| `utilization` | 0..1 spent | `quota-aware` |
| `overageStatus` / `overageResetsAt` / `isUsingOverage` | paid-overage state | policy + admin UI |
| `surpassedThreshold` | threshold that triggered the event | diagnostics |

Windows: `five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, `overage`. Events without a
`rateLimitType` land in an internal `default` bucket that must never be rendered as a real window.

**The critical caveat: `utilization` is only populated near the limit** (`oauthUsage.ts:5-8`). It is
an *alarm*, not a gauge — a `quota-aware` policy built only on SDK events sees `null` headroom for
most of every window and degrades to round-robin.

The optional secondary source closes that gap: `GET https://api.anthropic.com/api/oauth/usage` with
`anthropic-beta: oauth-2025-04-20` returns **continuous** percentages for every active window
(0..100 → normalize to 0..1), an `extra_usage` block (`isEnabled`, `monthlyLimit`, `usedCredits`,
`currency`), and model-scoped weekly limits. It reads the access token from the Account's config dir.
Merge rule worth copying verbatim: **OAuth values win for `utilization` / `resetsAt`; SDK events
fill in overage detail and any window the endpoint omits; a `rejected` SDK status is never
downgraded** (`server.ts:4096-4114`). Hygiene for both: 30 s TTL cache per Account, concurrent
readers share one in-flight request, and a transient failure serves the last-good snapshot within a
bound (15 min) rather than blanking the routing view.

| Signal | Consumer |
|---|---|
| `status: rejected`, or a 429-classified error | Circuit breaker → Account `cooling_down` until `resetsAt` (capped); exponential backoff when no reset is reported. The half-open probe is **scheduled per Account for when its reset passes**, never a fixed-interval sweep ([09-deployment.md](09-deployment.md)) |
| `utilization` per window | `quota-aware`: prefer the Account with the most headroom |
| `extra_usage` exhausted | Distinguish "out of subscription" from "out of paid overage" — separate error classes (`errors.ts:198`) |
| Per-Account snapshot | Admin UI headroom, `/metrics` |

Note the scheduling shape: because `rate_limit_event` rides responses we are already making, an
actively used Account needs **no polling at all**. Only idle Accounts need the slow background floor
that reads the OAuth usage endpoint — an in-process jittered timer holding a Postgres advisory lock,
not a queue or a worker.

---

## 6. Protocol re-synthesis

There is nothing to proxy. **Even `POST /v1/messages` against a Claude subscription is a
re-synthesis, not a passthrough.**

| SDK `message.type` | Contains | What we do |
|---|---|---|
| `system` (`subtype: "init"`) | `session_id` | Capture for the Session mapping |
| `stream_event` | a raw Anthropic wire event in `.event` | The **only** type whose payload reaches the client — after field stripping, index remapping, block filtering |
| `assistant` | full message + `uuid` + `usage` | Non-stream: the content source. Stream: UUID capture for undo, early-stop arming. Its `usage` covers only the last internal iteration — **not authoritative** |
| `user` | tool results the SDK produced internally | Early-stop bookkeeping (§7) |
| `result` | aggregate `usage`, structured output | **Authoritative** usage for the `UsageRecord` |
| `rate_limit_event` | `rate_limit_info` | Account quota state (§5) |

### SSE out — Anthropic dialect

| Client-visible frame | Source | Also synthesized for |
|---|---|---|
| `message_start` | first forwarded `stream_event`, **once** | structured output, tool-only turns |
| `content_block_start` / `_delta` / `_stop` | forwarded `stream_event`s | passthrough tool_use blocks, error recovery |
| `message_delta` (`stop_reason`, `usage.output_tokens`) | forwarded or synthesized | early stop, tool_use termination, error close |
| `message_stop` | exactly one, after the loop | always terminal |
| `error` | classified failure | — |
| `: ping` | every 15 s | keep-alive |

- **Block indices are ours** — the SDK restarts them per internal turn; a monotonic
  SDK→client index map is required (`server.ts:2516`).
- **Intermediate `message_stop`s are dropped** — the SDK emits one per internal turn; the contract is one.
- **Block filtering must skip the whole start/delta/stop triple**, not just the start.
- **Heartbeats hide upstream stalls.** Our `: ping` resets the client's idle timer, so a separate
  **upstream** idle guard (90 s in Meridian, `streamIdleGuard.ts`) must race each `next()` → `504`.

### OpenAI dialect out

Meridian translates OpenAI requests into the Anthropic shape and re-enters `/v1/messages`
**in-process** (`server.ts:3789`, `:3930`) — one re-synthesis engine, two front doors. Right call
for us: **render SDK → Anthropic Messages once, then reuse the Anthropic → OpenAI translator from
[06](06-protocol-translation.md).** Do not write a second SDK → OpenAI renderer. Two boundaries stay
distinct: OpenAI ⇄ Anthropic is ordinary translation; Anthropic ⇄ `query()` is where the loss is.

Costs of the internal hop, and three things not to copy:

- Account selection must happen **once at ingress and be carried structurally**, never re-derived
  from forwarded headers — Meridian's two front doors already forward different header sets.
- Its chat-completions path deliberately **bypasses session resumption**, flattening prior turns
  into a `<conversation_history>` system block (`openai.ts:7-17`): fresh SDK session per request,
  cold cache every turn, earlier images degraded to the literal text `[Image attached]`. Its
  Responses path does the opposite and is the pattern — session keyed on the client's
  `prompt_cache_key`, so signed thinking and cache survive *by session identity*.
- Its Responses output reports `status: "completed"` unconditionally, so `max_tokens` truncation is
  invisible.

Worth stealing verbatim: a Responses SSE payload must carry its own `type` **inside the JSON data
object**, not only on the `event:` line, or Codex's tagged deserializer reports "stream closed
before response.completed" though every event was sent (`openaiResponses.ts:343-352`).

### Where fidelity is lost

| Loss | Why |
|---|---|
| **Sampling parameters** (`temperature`, `top_p`, `max_tokens`, `stop`, `top_k`, penalties, `seed`, `n`, `logprobs`) | `query()` has no equivalents. Accepted and **ignored** — document per field. `reasoning_effort` is the exception, mapped to the SDK effort scale (`low`…`max`; OpenAI's `minimal` has no target) |
| `n > 1`, `system_fingerprint`, determinism guarantees | Never surfaced |
| Ids, event boundaries, byte parity | Constructed by us. Avoid Meridian's `msg_${Date.now()}` — it collides under concurrency |
| Fields the SDK does not surface | Cannot be re-synthesized; "new upstream features survive" does not hold here |
| Client `cache_control` hints | Caching is the SDK's, not the client's |
| `usage` decomposition | SDK `input_tokens` **excludes** cache reads, so naive `prompt_tokens` under-reports context. `cache_creation` sub-breakdown, `prompt_tokens_details.cached_tokens`, and reasoning-token counts are unavailable. **This is the cost basis of a `UsageRecord`** |
| Thinking signatures | A block reconstructed from client text is unsigned; continuity must come from session identity |
| `pause_turn`, `refusal` | No OpenAI target — collapse to `stop`; no `content_filter` path |
| `tool_result.is_error` | OpenAI's `tool` role has no error channel; failures read as successes |
| Anthropic **server** tools, citations, code execution, computer use | The SDK cannot emit `server_tool_use`. Reject `400` naming the field — and do **not** advertise these in `GET /v1/models` |
| Beta opt-ins | The SDK owns the request; only a filtered subset passes as `betas` (§7) |

Meridian injects a canned fallback sentence when the SDK returns no content (`server.ts:2068-2074`).
**A router must never fabricate model output** — return an empty completion with an honest stop reason.

---

## 7. Tool handling — the genuinely hard part

Roughly **40–45 % of Meridian's request-path code (~3,300 of ~8,000 LOC) is tool-related**, split
about 40/60 between "which toolkit wins" and "stop the agent loop from running autonomously."

**The root problem.** The SDK subprocess is a full agent with its own built-ins (Read, Write, Edit,
Bash, Glob, Grep, Task, WebFetch, TodoWrite, …). The client *also* sends `tools[]` and expects
`tool_use` blocks matching *its* names and schemas. Two toolkits, one model: if both are live the
model calls `Read(file_path=…)` and the client — which knows `read(filePath=…)` — cannot execute it.

| Category | Contents | Why |
|---|---|---|
| Blocked built-ins | SDK tools the client has an equivalent for | Force the model onto the client's version (`tools.ts:13`) |
| Client-only SDK tools | no client equivalent, or a colliding schema | Prevent calls the client cannot answer (`tools.ts:27`) |
| Anthropic server tools | dated `web_search_*` / `web_fetch_*` | Unsupportable — reject `400` |
| Deliberately **not** blocked | `ToolSearch` | The SDK needs it for deferred tool loading |

Two execution modes exist. **Internal MCP** — the SDK calls an in-process server that really runs
`bash`/`read`/`write` **on the router host** — is a non-starter for a multi-tenant router: arbitrary
command execution on behalf of any key holder. Meridian ships it because it is a single-user local
proxy. **We support passthrough only, and say so.**

In passthrough the client's tools are registered on an in-process MCP server whose handlers are
**no-ops** — they exist only so the model emits well-formed `tool_use` (`passthroughTools.ts:75-137`).
A `PreToolUse` hook then denies and captures every call, and the captures are emitted to the client
as synthetic blocks with `stop_reason: "tool_use"`.

| Mechanism | Why it exists |
|---|---|
| `tools: []` in the options | `disallowedTools` blocks *invocation* but leaves the ~25 k-token built-in catalog in the upstream payload; only `tools: []` elides it (`query.ts:274`) |
| Deterministic (alphabetical) registration | Registration order changes the SDK system prompt, which blows the prompt cache |
| `maxTurns` ≈ 3–4 (vs 200 internal) | After each deny the SDK still runs a "digest" turn; the budget bounds it (`query.ts:154`) |
| Early stop | That digest turn is fully billed, and on always-thinking models costs a thinking pass per tool step. Abort once every denied call is observed (`passthroughEarlyStop.ts`) |
| Deny-hold | A deny landing while later parallel blocks still generate makes the CLI cancel the in-flight request and truncate them — hold denies until `message_delta` |
| Turn-2 suppression | Drop everything after the second `message_start`; force `stop_reason: tool_use` |
| `max_turns` → `tool_use` recovery | Budget exhaustion becomes a clean tool-use stop, not a 500 |
| Name un-prefixing | The SDK is **inconsistent** about whether a stream event carries `mcp__<server>__`; handle both |
| Param-name repair | Claude Code's prompt teaches `snake_case`, clients often use `camelCase` — repair only when a *required* param is missing |
| Deferred tool loading | Above ~15 tools, non-core ones are deferred behind `ToolSearch` — costs one extra turn |
| Envelope-integrity assertions | Assert per response that no captured tool call was dropped and no tool input is empty; these bugs are otherwise silent |

Subagents: a client's `Task`-style tool is opaque to the SDK, so agent definitions are synthesized
from its description text and registered as SDK `agents` with `model: "inherit"` (subagent traffic
returns through the router). The SDK validates `subagent_type` **before** hooks can rewrite it, so
name variants must be pre-registered and invented names need fuzzy repair (`agentDefs.ts`).

Beta headers are filtered, not forwarded blindly: on a subscription Account billable betas (extended
cache TTL) are stripped while prompt caching, 1 M context, and fine-grained tool streaming pass
through. An earlier unconditional strip cost a cache miss every turn (`betas.ts:11-14`). For us this
is **per-Account billing safety**.

---

## 8. Per-client adapters

Meridian carries ten adapters (`adapters/`) plus a parallel transform registry (`transforms/`). The
intended split: an **adapter** is identity (detect the client, find its session id and working
directory, name its MCP server, normalize content for hashing); a **transform** is behavior, a
`{ onRequest, onResponse, onTelemetry }` chain over a `RequestContext`, which doubles as the plugin API.

**The split did not hold, and that is the most useful finding.** The behavioral half of
`AgentAdapter` was never removed after the transform migration — the server reads the pipeline
context instead. A 232-line parity suite exists solely to keep the two mirrors in sync, and it still
missed the obvious failure: the `claude-code` adapter has **no registry entry**, so its
`usesPassthrough`, `supportsThinking`, and tool lists appear never to take effect, silently, with no
failing test. Six near-identical copies of file-change extraction differ only in `filePath` vs
`file_path`; three adapter names map to the same transform set.

Adapter surface (`adapter.ts`) — read as a *catalogue of axes that vary*, not an interface to implement:

| Method | Controls |
|---|---|
| `getSessionId(c, body)` | Which header carries the Session key |
| `extractWorkingDirectory` / `extractClientWorkingDirectory` | SDK subprocess `cwd` (**must exist on our host**) vs. the client's own path, used for fingerprinting and a prompt note |
| `normalizeContent` | Stable string for lineage hashing |
| `getMcpServerName` | Tool prefix `mcp__<name>__` |
| `getBlockedBuiltinTools` / `getAgentIncompatibleTools` / `getAllowedMcpTools` / `getCoreToolNames` | Tool policy (§7) |
| `usesPassthrough` / `prefersStreaming` / `supportsThinking` | Execution mode, SSE, thinking blocks |
| `getSettingSources` | Whether the SDK loads `CLAUDE.md` / user settings |
| `buildSdkAgents` / `buildSdkHooks` / `buildSystemContextAddendum` | Subagents, hooks, prompt addenda |
| `leaksCwdViaSystemReminder` / `extractFileChangesFromToolUse` | `<system-reminder>` stripping; cosmetic file-change summaries |

**Detection is header sniffing only** — explicit override header, then a `User-Agent` prefix table
(`opencode/`, `factory-cli/`, `Charm-Crush/`, `claude-cli/`, `litellm/`), then a default. Never body
shape. Several clients have **no reliable signal** (Cherry Studio, ForgeCode, Pi — which impersonates
`claude-cli/`), and **Cline and Cursor have no adapter at all**; they fall through to the default.
That caps how much per-client behavior is even reachable.

**Our recommendation: one generic path parameterized by request-derived flags, not N adapters.** The
real axis of variation is a handful of orthogonal booleans, most derivable from the request itself.

| # | Genuinely mandatory | Failure mode |
|---|---|---|
| 1 | **Passthrough mode** | The most load-bearing bit: a tool-executing client in internal mode waits forever; a chat client in passthrough loops on blocks it cannot execute. Derivable from whether the client sent `tools` |
| 2 | **`settingSources: []`** | Cross-tenant leak of the router host's `CLAUDE.md` (§3) |
| 3 | **Server-controlled subprocess `cwd`** | A client path that does not exist here fails the spawn with a misleading error. Every client is remote for us, so treat the client cwd as advisory only — *simpler* than Meridian's four cwd-parsing regexes, which exist because it is a local proxy |
| 4 | **Tool-name collision blocking** | Generic rule: if the client sent tools, block colliding SDK built-ins plus all client-only SDK tools. No per-client config |
| 5 | **Env stripping** | Subprocess loops back through our own router (§3) |
| 6 | **Session keying** | Cache-miss storm. One router-defined header plus fingerprint fallback covers most clients |
| 7 | **No silent model substitution** | Meridian collapses every model string onto seven tier aliases (`gpt-4o` → Sonnet, silently). Our invariant is the client picks the model — pass it through or fail clearly |

Polish, safe to default: thinking forwarding (default *strip*), file-change summaries (default *off*
— Meridian's sanitizer has to strip its own summary back out next turn), deferred tool loading,
subagent name repair, and the Claude Code system-prompt preset (a real ~28 KB decision, but a
per-Account **setting**, not a detected client behavior).

Keep one seam — a small `ClientProfile` resolved by detection with defaults for everything, plus one
request hook for genuine one-offs. The three per-client parsers worth porting encode facts about
clients we cannot change: Claude Code's session id buried as JSON in `metadata.user_id`, Droid's
working directory hidden in `<system-reminder>` blocks, and LiteLLM's `x-litellm-*` headers.

---

## 9. Operational notes

**The glibc/musl trap.** The `claude` CLI is a *platform-native* binary. Build on Debian/glibc, run
on Alpine/musl, and the file is present but cannot exec — `ENOENT` despite existing, because the
dynamic loader path differs. `@anthropic-ai/claude-code` acquires it in a postinstall
(`install.cjs`), so a build that wants that package must pass `--ignore-scripts` in the build stage
and run `install.cjs` **in the runtime stage** so the binary matches the runtime libc; a separate
musl platform package exists (`@anthropic-ai/claude-code-linux-<arch>-musl`). Either way the binary
belongs on `PATH` as `claude` — a *symlink* or the real executable, never a shell wrapper, which the
SDK's launcher rejects on some paths — so `claude auth status` and the SDK resolve the same file.

**How our image actually does it, and why it differs.** `@anthropic-ai/claude-agent-sdk` (0.3.220+)
ships the same binary as its *own* prebuilt optional dependency
(`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, glibc and musl variants), and its internal
resolution says so: it fails with "Reinstall `@anthropic-ai/claude-agent-sdk` without
`--omit=optional`, or set `options.pathToClaudeCodeExecutable`". So we install **no** second CLI
package: `bun install` already puts a lockfile-pinned binary in the tree, at a version that cannot
skew from the SDK calling it, with no network fetch or postinstall at image-build time. The builder
stage stages that exact file (found by running our own resolver — never a hard-coded store path,
which would drift the moment bun changes its layout) and the runtime stage copies it to
`/usr/local/bin/claude` and runs `claude --version`, so the libc trap fails the **build** instead of
the first subscription request. `--ignore-scripts` stays on both builder installs as a security
floor. This makes the builder and runtime bases share a libc — the invariant the `RUN` enforces.

**Executable resolution is a ladder and must be observable**: env override (`CLAUDE_CLI_PATH`, and a
set-but-unusable pin *fails* rather than falling through to a binary nobody named) → bundled binary
(`@anthropic-ai/claude-code`'s `bin/claude.exe` — that one filename on every platform, skipping the
~500-byte stub a skipped postinstall leaves) → SDK platform package (same candidate order the SDK
walks, resolved from the SDK's own directory because bun installs a package's deps beside it) →
`PATH` lookup → legacy native-installer paths. `/readyz` reports **which rung won**; "the wrong
`claude` got picked" is otherwise indistinguishable from any other SDK error. The path is logged,
not returned: `/readyz` is unauthenticated. Implementation:
`apps/api/src/providers/claude-sdk/resolve-cli.ts` (pure ladder) + `cli-probe.ts` (host facts).

| Concern | Design |
|---|---|
| Concurrency | A semaphore over `query()`, sized to memory not CPU. Ours must be **global and per-Account** — one Account's burst must not starve the Pool |
| Cancellation | One `AbortController` per request, wired to the HTTP signal and the SDK; aborting terminates the subprocess. No separate `interrupt()`/`kill()` in Meridian |
| Client disconnect | Detect closed-stream writes, stop the loop, abort, detach. Never orphan a subprocess |
| Timeouts | Client keep-alive ≈ 15 s; **upstream** idle guard ≈ 90 s → 504. Independent, both needed |
| Retries | Bounded, and **forbidden once bytes are on the wire** — the same rule as [05-routing-and-failover.md](05-routing-and-failover.md) |

**Error classification.** SDK failures arrive as strings, so classification is substring matching on
the message plus the subprocess stderr tail. Classes worth naming as our own error types:

| Class | Signal | Response |
|---|---|---|
| Expired credential | `oauth token has expired`, `not logged in`, `401` | Account → `needs_reauth`, drop from routing, fail over to the next Account in the Pool. **We do not refresh-and-retry** the way Meridian does — the SDK owns the token (§3) |
| Rate limited | `429`, `rate limit`, `usage limit reached` | 429 + circuit breaker; fail over to the next Account |
| Stale SDK session | `No conversation found with session ID` | Evict the Session mapping, replay once |
| Busy session | `is currently running as a background agent` | Bounded linear retries, then `forkSession` |
| Overage required | `extra usage` + `1m` | Drop the extended-context variant, cool down |
| Subprocess crash | `exited with code N` + stderr | 502. Meridian maps a generic exit-1 to 401 on a heuristic — **do not copy that**; classify honestly and log the stderr tail |
| Upstream idle | Guard expiry | 504 |

---

## 10. Copy · skip · do differently

| Copy | Skip | Must do differently |
|---|---|---|
| The `CLAUDE_CONFIG_DIR`-per-Account isolation model, wholesale | Internal MCP tool execution — arbitrary bash on the router host disqualifies it for us | **Per-Account rate-limit state.** Meridian's `rateLimitStore` is a process singleton *cleared on profile switch* (`rateLimitStore.ts:87`). Unusable for us: we need `Map<accountId, windows>` with no cross-Account clearing |
| Two-cache session resolution + the full lineage table, incl. replay-guard and modified-continuation | The plugin system — out of scope for v1 | **Sticky routing is correctness.** An `sdkSessionId` is resumable only on its own Account; a policy that moves a Session must invalidate the mapping |
| Coordinated LRU eviction across both caches | The 4.5 k-line handler — our SRP rules cap files at 300 LOC | **Per-key scoping and accounting.** Meridian has one user and no keys. Every request carries `(ApiKey, Account, Session)` into a `UsageRecord`; the candidate set is always Pool ∩ key scope |
| `rate_limit_event` → circuit breaker, plus the OAuth usage endpoint as continuous secondary source with Meridian's exact merge rule | Ten per-client adapters on day one (§8) | **Concurrency accounting.** A single global semaphore is fine for one user; we need global **and** per-Account limits |
| Passthrough in full: `tools: []`, deterministic registration, deny hook, deny-hold, early stop, turn-2 suppression, envelope-integrity assertions | **`tokenRefresh.ts` in its entirety** — expiry timers, background scheduler, direct credential writes. The SDK owns subscription tokens; we only observe auth failure and set `needs_reauth` (§3). Keep it as reference for the *file format*, never as an implementation | **Credential handling.** Drive the `claude` CLI for login and let it own the credential format; the router never mints, schedules, or writes a subscription token |
| `settingSources: []` and env stripping, verbatim — both are isolation guarantees | Anthropic *server* tool support (impossible) | **Storage.** Their JSON file + advisory *lock files* → a **PostgreSQL** table with the LRU pair in front. Their lock-file scheme exists only because a JSON file has no cross-process coordination; `pg_try_advisory_lock` gives us the same guarantee for free, and it is also how any sweep over that table elects a single replica |
| Executable-resolution ladder + `/health` source reporting; the Dockerfile build-vs-runtime libc split | Meridian's OpenAI chat path, which bypasses session resumption and pays a cold cache every turn | **Model naming.** No collapsing onto tier aliases; the client picks the model unless the Account defines an alias map |
| Beta-header filtering as billing safety; the anti-imitation framing for unavoidable flat replays | Time-based expiry decisions inherited from a local tool | **Never fabricate model output**, and document the ignored sampling parameters per field in [06](06-protocol-translation.md) rather than letting users discover them |

Meridian's *profile* is close to our **Account**: a named auth context resolved per request with
header > sticky > active > default precedence. The differences that bite — a profile has no
lifecycle, health state, weight, or usage history; there is one globally *active* profile, which has
no meaning for us; and profile switching clears global state we must keep per Account. Take the
mechanism, not the model.

---

## 11. Open questions and risks

1. **Subprocess cost at team scale.** What are the real memory and startup costs of one `claude` CLI
   subprocess, and how many can one container sustain? Does that make a per-Account concurrency cap
   a routing *input* rather than a safety valve?
2. **Can a subprocess be reused** across several HTTP requests, and would that break the per-request
   abort contract?
3. **Session-mapping retention.** Meridian applies no time-based expiry because SDK sessions live
   for weeks upstream. Does the 24 h idle sweep in [09-deployment.md](09-deployment.md) apply to
   this table at all, and what bound is right?
4. **Config-directory growth.** Transcripts accumulate per Account. Who prunes them, on what signal,
   and can pruning break `resume`?
5. **Does `quota-aware` work without the OAuth usage endpoint?** SDK `utilization` is only populated
   near the limit. If the endpoint stays strictly optional, does the policy degrade to round-robin
   in practice — and is the endpoint therefore effectively mandatory?
6. **Concurrent `query()` calls against one config directory** share a credential store and a
   session directory, and the CLI may rewrite credentials underneath them. Is that safe, or does an
   Account need a serialization point of its own?
7. **Auth-failure detection.** Since we never refresh subscription tokens ourselves, `needs_reauth`
   depends entirely on recognizing the SDK's auth failures — which arrive as substrings (§9). How do
   we detect a *silently* degrading Account, and is periodic `claude auth status` the right probe
   or does running it per Account cost more than it reveals?
8. **Detection without adapters.** Can one generic path plus a session-header list actually serve
   Claude Code, OpenCode, Codex, Cline, and Cursor, or does the first integration force a per-client record?
9. **Tool-loop fidelity.** Which client behaviors (parallel tool calls, interleaved thinking,
   `tool_choice: {type:"tool"}`) do we commit to in v1, and which are documented gaps?
10. **Cost attribution.** The SDK `result` message is authoritative, but a stream closed early never
    delivers it to the client. Do we bill from `result` regardless, and how do we reconcile that in the UI?
11. **Multi-arch.** Does the `claude` CLI ship a working `linux/arm64` (and musl-arm64) binary for
    every version we might pin? A missing platform package degrades silently to a `PATH` lookup.
