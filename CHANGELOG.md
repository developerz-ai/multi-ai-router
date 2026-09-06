# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.6] — 2026-09-06

### Added

- **The truncation alarm names the tool surface the turn ran with.** Turns still end occasionally on a `tool_use` block that never closes, and the two explanations have opposite fixes: a client that declared tools has a passthrough, so `ToolRewriter.flush` should already have closed that block and something upstream of it is wrong; a client that declared none has no passthrough and no flush at all, and a `tool_use` block appearing at all in that case would mean the built-in catalog `options.ts` elides with `tools: []` was not fully elided — a different bug in a different file. `declaredTools` and `passthrough` on `sdk turn ended mid-answer` say which, instead of costing another measurement round against boxes under live load. Added in the invoker rather than the renderer, which is pure and knows nothing about tools.

### Documentation

- `docs/idea/11-anthropic-agent-sdk.md` §9 records what `lastSystemSubtype` is and is not: the subtype of the last `system` message seen *anywhere* in the turn, **not** the one that ended it. A turn whose stream stops long after a `system` still reports that subtype, and reading it as an ending sent one investigation after a thinking budget that was never involved — the router sets none at all.

## [2.10.5] — 2026-09-06

### Added

- **`request completed` names the conversation and the client.** The line carried method, path, status and the router's own requestId — nothing that says *whose* conversation it was, so a session collision was invisible in production: two requests contending for one SDK session look exactly like one request that died, until you can see they carried the same id. It now carries `x-session-id` and `x-parent-session-id` (a subagent runs in its own session, concurrently with its parent by design, and seeing both is what distinguishes that from two turns of one conversation racing), plus `x-opencode-client` / `-host` / `-model` where a client sets them — a fleet-wide symptom that turns out to be one box, one client build or one model is a different investigation from one that is not. An allowlist rather than "log the headers": a request's headers carry credentials, and the way to be sure none is logged is to name the ones that are not. Values are bounded, like the session key itself.

### Fixed

- **The harness scrub had drifted against opencode 1.18.29.** `BRAND_TOKENS` was case-sensitive, so it matched `OpenCode` and none of the lower-case `opencode` that the built-in `customize-opencode` skill description says a dozen times — the fingerprint travelled anyway. Now case-insensitive, with the longer `OhMyOpenCode` alternative listed first so it is not eaten from the middle. The `You are OpenCode, the best coding agent on the planet.` identity line no longer exists in the V2 prompt, which opens with a generic `You are an AI coding agent.` that carries no brand and is deliberately not scrubbed; that rule is kept and labelled legacy coverage for the older builds a fleet still runs, since it costs nothing when absent.

### Documentation

- `services/dataplane/body/session.ts` states as a rule what was previously an accident: `x-parent-session-id` is **not** a session-key header. A subagent sends its own `x-session-id` and is keyed on that; keying a child on its parent would bind two live conversations to one SDK session, which is the collision rather than the fix. The parent id is logged and routes nothing.

## [2.10.4] — 2026-09-06

### Fixed

- **A translated stream went silent while the upstream was thinking, and the connection died under it.** Same pod, same account, same prompt, back to back, inside the cluster: `/v1/chat/completions` received 210 bytes and the socket closed at 11.9 s, while `/v1/messages` — the byte relay, no translation — carried 20,469 bytes of the same answer and was still streaming when the probe's 22 s cap stopped it. The only difference between the two is the translation. `thinking` and `redacted_thinking` deltas have no openai-chat counterpart and are dropped, correctly — but an extended-thinking model spends its opening stretch emitting nothing else, so the upstream stream is busy while the translated one writes zero bytes and the client's connection sits idle through the whole thinking phase. A chunk that produces no client event now keeps the connection alive when it has been quiet long enough (`DEFAULT_TRANSLATED_KEEPALIVE_MS`, 5 s): an SSE **comment**, which carries no event and no data in any dialect, so a dropped frame never acquires a counterpart just because the connection needed a byte; it does not count as the first byte, for the same reason a forwarded upstream keepalive does not; and it is bounded by a cadence rather than sent per chunk.

  This is the cause behind the truncated agent turns that 2.10.1–2.10.3 chased through tool handling, hidden one-shots and proxy timeouts. Every symptom pointed upstream: the teardown aborts the request, the subprocess dies mid-thinking, and the renderer reports a turn that ended with a `thinking` block open (`sdk turn ended mid-answer`, `lastSystemSubtype: "thinking_tokens"`, no `result`). That diagnostic — added in 2.10.2 and made legible in 2.10.3 — is what found it. It also explains why short requests always succeeded (they finish before the quiet window opens) and why one run of a prompt gave 2 chunks in 11 s while the next gave 3,892 lines in 122 s (the second started emitting text early, so bytes were flowing).

## [2.10.3] — 2026-09-06

### Fixed

- **The truncation alarm 2.10.2 shipped could not answer its own question.** Its first production line read `"kinds":[""]` and `"messages":"[REDACTED]"`: the block's own type was never recorded — `content_block_start` called into the index map without passing it — so a truncated `tool_use` was indistinguishable from a truncated `text`, and the message counter was named `messages`, which is on the log redactor's list because it is what a request body calls its conversation. Block kinds are recorded, the counter is `sdkMessages`, and the alarm additionally carries `lastSystemSubtype`: the line did manage to say that the turn's last SDK message was a `system` one with no `result` after it, and `system` covers several different things whose difference is the difference between a session opening and a run being cut short.

## [2.10.2] — 2026-09-06

### Fixed

- **A turn that stopped mid-answer was handed to the client as a complete one.** Under real fleet load ~1.4% of requests ended with the router logging `sdk stream closed with unterminated content blocks` — and then answering normally. Each one killed an entire agent turn, and the router was the only component that knew the answer was broken and the only one that said nothing about it. Reproduced with a plain **tool-free** request: one run answered in 2 chunks and 11 s where the next gave 3,892 lines and 122 s for the same prompt — so it is not tools, not a harness fingerprint, not session binding, and not an idle timeout anywhere in the path (a 122-second stream survived the whole chain and terminated cleanly). Now, when the stream ends with content blocks still open **and nothing ever stated a stop reason**, the blocks are still closed — a parser is owed sound framing whatever happened — but what follows them is an `error`, not a `message_delta` and a `message_stop`. A client gets a failure it can react to instead of half an answer that looks whole, and a *non-streaming* turn of the same shape becomes a real status before any byte is out, so the failover chain tries the next account instead of the caller ever seeing it. The stop reason separates the two shapes and only one is this failure: an upstream that stated `end_turn` and merely dropped a `content_block_stop` sent a whole answer with one framing event missing, which is repaired and finishes cleanly exactly as before.
- **A tool call's arguments could be lost entirely.** A `tool_use` block's arguments are buffered until its `content_block_stop`, and the early stop ends the SDK loop the instant every emitted call has been denied — a race the stop sometimes wins, taking the held arguments with it. The client then received a block carrying its name, its id and nothing else: `arguments: ""` on the openai wire, which is not JSON, so the reader threw before it could run anything. `ToolRewriter.flush` now empties that hold when the loop ends, preferring the input the `PreToolUse` hook was handed **assembled** over a buffer that may hold only a truncated prefix of it.
- **The truncation alarm now says which early ending it was.** `sdk turn ended mid-answer` carries the open block kinds, the last SDK message and wire event, whether a `result` arrived at all, and how many messages and client frames the turn produced — enough to tell the query iterator completing from a `result` landing mid-block from the subprocess dying, which a bare count never could.
- **A per-request fault was being read as evidence about the account.** An SDK `busy-session` reached the breaker as `server-error`, so it counted toward the failure threshold: three in a row parked a subscription that was answering fine, and under agent load those collisions land on account after account until a healthy pool has walked itself into a cooldown and the next caller is told there is no capacity. Retryable and blameless are different questions, and this is the one kind that answers them differently — the chain still moves on, and the account it left keeps its streak and its status. `subprocess-crash` stays counted, deliberately: a dead subprocess may be this account's config directory or may be this one request, and an ambiguous fault is what a threshold is for.
- **`/api/admin/usage` answered 500, and had since long before 2.10.x.** The operator console's usage dashboard was dead while `/usage/recent` beside it was fine: `TypeError: row2 is not a function`. `usage-read/service.ts` had a module-scope function literally named `row2`, and a bundler renames a local that collides with a hoisted binding by appending a digit — so `row` became `row2`, shadowed the function, and every call site invoked a plain object. The source is correct and every test over it passes, which is why 3,900 tests never saw it: only the shipped artifact has the collision. Renamed to `breakdownRow`, and `bundle-shadowing.test.ts` builds the API with the same command `bin/build` ships and refuses any module-scope function shadowed by a bundler-renamed local at its own call site. (`GET /api/admin/usage?window=24h` → 400 is correct and unchanged: the window is a named enum and the error already says which values it accepts.)

### Documentation

- `docs/idea/11-anthropic-agent-sdk.md` §4 gains "A turn that stopped mid-answer is a failure, not a completion" — the measurement, the stop-reason distinction, and what the alarm now carries. `docs/idea/05-routing-and-failover.md` records that retryable and blameless are separate questions, and which kinds answer them differently.

## [2.10.1] — 2026-09-06

### Fixed

- **A hidden one-shot could take a running conversation's SDK session away from it.** Coding-agent clients fire hidden requests — a conversation title, a summary — carrying the **same** session header as the visible turn and often in parallel with it. Both resolved to one SDK session, the second asked the `claude` CLI to resume a session the first was still running, and the CLI refused — on stderr, behind an `exit 1`, so it read as a subprocess crash, answered `502`, and failed the user's conversation over onto a cold account mid-turn. `providers/claude-sdk/session/inflight.ts` now claims the session key for the duration of a turn: a second request arriving while it is held runs **detached** — a fresh SDK session (`FreshReason: "session-busy"`), and it records nothing. Both halves matter, which is why forking is the backstop and not the answer: a fork would serve the one-shot, but its new session id is what the turn then binds to the conversation, so a throwaway "write me a title" would take ownership of the user's durable lineage. The claim is released by the **answer's own body finishing** — drained, cancelled by a client that went away, or errored — rather than by a callback an invoker could forget, because forgetting it would detach every later turn of every conversation silently. Per replica, and honestly so.
- **The CLI's busy-session wording had drifted, and only the old spelling was matched.** 0.3.x says `is currently running as a background agent`; 2.1.x says `is running as a background session`. The newer one fell past that row to `claude-sdk:subprocess-exit`, which is why the in-place fork recovery that already existed for this condition never ran. Both are matched now, ordered ahead of the crash rule.
- **An openai-chat stream could end with nothing that says it ended.** Two shapes, both measured through the real renderer and the real translator: a turn whose SDK stream stopped mid-block emitted a terminal chunk carrying `finish_reason: null` — nothing in the whole stream ever finished — and a turn whose subprocess died mid-answer emitted an error object and then stopped dead, with no terminal chunk and no `[DONE]`. A client's reader waited at EOF and reported a parse failure with the real cause nowhere in it (opencode's `Failed to read … stream` on a long agent turn). `finish_reason: null` means different things in the two dialects: Anthropic's `stop_reason` is legitimately null, while on the openai wire a null finish says *more is coming*. The mapping stays honest; the **terminal** chunk falls back to the conservative reason the shared table already names, and an upstream error now goes out first — so nothing masks it — followed by a terminal chunk and `[DONE]`. A stream truncated at the transport still gets nothing, deliberately: the upstream never said the message was over.

### Documentation

- `docs/idea/11-anthropic-agent-sdk.md` §4 gains "One conversation, one turn at a time" — why a concurrent turn is detached rather than forked, why the release is the response body, and what one replica does and does not cover — and its §9 classification row records both busy-session spellings. `docs/idea/06-protocol-translation.md` gains the absence and error-termination rules beside the stop-and-finish table.

## [2.10.0] — 2026-09-05

### Fixed

- **Every agent-sized request from opencode answered `400 "the upstream rejected the request as malformed"`.** The request was not malformed. Anthropic meters a subscription request partly by *who appears to be asking*, and the prompt carried a second harness's fingerprints inside a turn the Agent SDK makes as Claude Code: `API Error: 400 Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going.` Bisected to opencode's environment preamble and its `<env>` block — Claude Code's own preset already injects that preamble, so opencode appending its own copy makes it appear **twice**, and the duplicate is the impersonation signal. Measured on `default`, `opus`, `sonnet`, `haiku` and `claude-opus-5`, and on every account in the pool: not model-specific, not account-specific, and unreachable by failover. `providers/claude-sdk/scrub.ts` removes the fingerprints where the system prompt crosses into `query()` — Agent-SDK egress only, never on the API-key or any other provider path, where the caller's prompt is a passthrough. Each rule is independent (a missing pattern is a no-op), idempotent, and conservative: tool policy, tone rules, task guidance and any user `CLAUDE.md` content survive verbatim. A prompt that was *only* a fingerprint scrubs to nothing, and nothing means the option is omitted, exactly as for a client that sent no system prompt.
- **That `400` read as `invalid-request`, so the router died on it instead of rotating.** `invalid-request` is not retryable — a bad request is bad at every account — so the failover planner never tried another subscription and the client got a dead-end error naming the wrong cause. The sentence is now a named phrase rule (`claude-sdk:extra-usage-gated`) ordered ahead of the bare `apiStatus(400)`, classified `rate-limited`: retryable, so the chain rotates to the next account; the breaker cools the failing one down so the pool is not burned on it again on the very next request; never `credits-exhausted`, which would park a healthy subscription at `402` until a human intervened (non-negotiable 7). When nothing in the pool can serve, the client gets one router-authored sentence naming Extra Usage and `claude.ai/settings/usage` — no account labels, no cooldown timers, no attempt counts.

### Changed

- **Failover walks the whole pool.** `ROUTING_MAX_ATTEMPTS` defaulted to `3`, so a six-subscription pool stopped after two failures with four healthy accounts unasked — the opposite of what a deep pool is for. The default is now the pool itself: the chain tries the next account, and the next, until one serves or every eligible candidate has been tried. It still terminates in at most one attempt per candidate, each a distinct account, and the request deadline still governs the chain. The knob remains for an operator who wants to fail faster than their pool allows; it can only lower the bound, never raise it past the candidates that exist.

### Documentation

- `docs/idea/11-anthropic-agent-sdk.md` §8 gains "the one edit a client's system prompt receives — harness fingerprints" (the measurement, the three properties, and why it is Agent-SDK egress only) and §9 the `Extra Usage gated` classification row. `docs/idea/05-routing-and-failover.md`, `docs/idea/09-deployment.md` and `.env.example` record the new attempt bound.

## [2.9.1] — 2026-09-05

### Fixed

- `/v1/models` on a Claude subscription lists the live handshake rows **and** the shipped family aliases and canonical ids (`opus`, `fable`, `haiku`, `claude-opus-5`, `claude-sonnet-5`, …); live rows win on an alias. A swept subscription had listed only the five rows the CLI reports.

## [2.9.0] — 2026-09-05

### routing

- **Fixed: `round-robin` / `weighted` (and `quota-aware`'s tiebreak) never rotated in production.** The policies read a per-pool `rotationCounter` "owned by the caller", and no caller set it — every rotation policy ran at `0`, a fixed head indistinguishable from the pool's declared order, so twenty new sessions on a six-subscription `round-robin` pool all landed on the first member. The dispatcher now owns a per-pool, per-replica counter (`services/dataplane/rotation.ts`) advanced once per placement the policy actually made: a turn whose Session → Account binding was honored does not move it, so on a Claude subscription pool consecutive *new* sessions land on consecutive subscriptions (20 agents on 6 subs → 4·4·3·3·3·3) and each then stays where it landed.
- **Fixed: a rejected credential mid-chain failed the request.** `401`/`403` (`auth`) was non-retryable, so the first request to land on a subscription whose 30-day login had expired answered `502 upstream_auth_failed` while healthy subscriptions sat beside it; only the *next* request routed around the parked account. `auth` is now retryable in both failure tables (`routing/failover.ts`, `providers/failure/classify.ts`): the account is parked `needs_reauth` / `disabled` exactly as before, one `upstream attempt failed … failureKind=auth` line is logged, and the chain continues to the next candidate — before any byte has reached the client, never after. A bound conversation that hops this way is stamped `x-router-session-restart: failover` and re-bound through the serving account's own session. `client-error` stays non-retryable. The `502` is still the answer when every candidate failed that way or `ROUTING_MAX_ATTEMPTS` ran out.
- **Spec honesty.** `docs/idea/05` no longer calls `round-robin` / `weighted` / `least-used` "unsafe as-is" on subscription pools: the binding is decided before any policy runs and pinned ahead of its ordering, so every policy respects a live binding and only places unbound sessions. `least-used` is documented as implemented (in-flight first, recent tokens as tiebreak; the token window bound stays deferred). The comparison table now says which policy suits a fleet of parallel agents — and that `priority-failover` piles every new agent onto the top account's per-account concurrency gate.
- **Tests.** `test/unit/routing/subscription-pool.test.ts` (6 subs × 20 sessions under every rotation policy; bound-keeps / cooling-rebinds / cooling-fails), `test/unit/dataplane/rotation.test.ts`, `test/integration/claude-sdk-fleet.test.ts` (20 concurrent streaming agents on a 6-sub `round-robin` pool through the real `createSdkConcurrency({global: 24, perAccount: 8})` gate: all served, 3–4 per sub, zero queued, no restart header, second turns resume in place; the same fleet under `priority-failover` queues 12 behind one account's gate), and the expired-login / quota-out mid-chain hops in `claude-sdk-session.test.ts` and `dataplane.test.ts`.

### web

- **Accounts page grouped by provider.** One collapsible section per provider — display name, worst status, `N accounts · M routable`, an attention count, the soonest subscription-login expiry — over the same dense table; groups with an account no clock will fix come first, then the biggest fleet. Sections keep their DOM (and fold state) across refetches, and the provider filter names providers by display name.
- **Subscription login expiry, visible a week early.** Each Claude subscription row reads its plan (`Max 20×`, `Pro`, `Team 5×`) and *Login valid until <local time> · <countdown>* from the new `credential` field, turning warn at 7 days and danger at 2; `present: false` or `needs_reauth` reads *Login expired — reconnect* with the button inline and never a countdown. A dashboard banner on Overview and Accounts (`N Claude subscriptions need a reconnect · M more expire within 7 days`) names the accounts and their deadlines. `exhausted` keeps its own red banner and "needs top-up".
- **Reconnect all.** From the banner or the group header: one guided sequence over the ordinary connect dialog — `Reconnect 2 of 6` in the title, the login started on arrival, authorize URL (copy / open), paste, success → *Next account*, *Skip this account*, *Stop*. Same three server calls as a single reconnect; no second implementation. A regression test pins that a refetched, equal-but-new account row does not restart the login (the first cut looped `POST /connect`, each spawning a `claude` process).
- **Every mutation invalidates its readers on settle, not only on success** — connect start / complete / cancel, re-check, test-now, model discovery — so a completion that failed after the CLI wrote its file, or a test that flipped the status, shows without F5. Test-now also invalidates usage. Accounts and pools poll every `LIVE_POLL_MS` (20 s, `lib/query.ts`) while the tab is visible; focus and reconnect refetches stay on. No client-side timer sends the operator to `/login` — only a server 401 does.
- **Quota gauge readings.** A window with `utilizationSource: "gauge"` renders as a filled bar with its percentage and a *reported* qualifier; the router's own count reads *measured*; a source this build does not know renders as a reading with an *unlabelled* origin instead of crashing the row. The gauge tooltip says where the number came from.
- **Keys → "Point your tool at it" → Claude Code** states that the key must be scoped to a pool holding the Claude subscriptions and, when the key's scope ∩ fleet reaches no `anthropic-oauth` account, says so in a warning on the panel.
- **Polish round.** Settings: the price table opens folded to its first 25 rows with a model/provider search box and *Show all N* / *Fold* (edited rows never fold away; `lib/price-filter.ts`, `PriceTableControls`) — the page drops from ~25 700 px to ~9 400 px. Accounts: usage and cost collapse into one `Usage · 7 days` column that reads *no traffic* for a silent row and puts *metered*/*notional* on hover (`TrafficCell`); the models cell is a count badge with a *show/hide* fold instead of an inline id list; *Weight / prio*; a narrower test-model input. Provider group headers name the pools the group's accounts belong to (joined client-side from the pools read — the accounts read carries no membership). Banners cap the account list at three names + *and N more*. `utilizationSource: "continuous"` — what the SDK's usage-gauge readings actually arrive as — renders exactly like `gauge` (*reported*, filled bar, tooltip "from the subscription's usage endpoint"); `gauge` kept as a synonym, unknown strings still fall back to *unlabelled*.
- UX pass: the usage chart says *No traffic in this window* instead of drawing three flat lines; a refused paste in the connect dialog is shown at the top of the body rather than below the fold; the mobile accounts page no longer scrolls horizontally (a visually-hidden gauge label escaped its table's scroll container); `AccountsRoute` split into `AccountsFilters`, `AccountsNotices`, `AccountDeleteDialog`, and the connect dialog's footer into `ConnectFooter`.

### auth

- **The operator stays signed in across deploys, for thirty days.** Admin sessions now live in Postgres (`admin_sessions`, migration `0023_admin_sessions`): the row stores a SHA-256 hash of the session id (the cookie is the bearer; a dump is not a bag of sessions), the CSRF token as-is, and both expiry bounds. A per-replica read-through cache keeps `authenticate()` off Postgres; the idle slide is written back at most once per `ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` (default 60, replaces `ADMIN_SESSION_SLIDE_FRACTION`), fire-and-forget; logout deletes the row synchronously; `admin_session_purge` is a bounded table sweep under the advisory lock. Defaults raised to `ADMIN_SESSION_IDLE_MINUTES=43200` / `ADMIN_SESSION_ABSOLUTE_HOURS=720` — the trade is written down in docs/idea/13. New knob `ADMIN_SESSION_CACHE_MAX` (1000). Every `bun --watch` restart and every weekly release used to answer `401` on the first console request.
- **Fixed: a reconnected subscription kept reading `needs_reauth` until Re-check.** The request path parks a dead credential in the row *and* in the health store's breaker, and the accounts read overlays the latter; completion cleared only the row. `connect/claude.ts` now calls the same `HealthStore.reset` Re-check does, refreshes the warm catalog, and logs `claude login started` / `completed` / `rejected` / `cancelled` per account — the six-account reconnect had left no line in the pod log at all.
- **Subscription login expiry on the admin API.** Every `anthropic-oauth` account carries `credential: { expiresAt, subscriptionType, rateLimitTier, present }` (null for other providers), read from the CLI's own credential file as *metadata only* — tokens are stripped before anything else touches the object, and a test asserts no token-shaped string survives. Cached per account for `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS` (60). An account whose tokens the CLI has blanked is parked `needs_reauth` on read rather than reported `active`.
- **Real usage percentages for Claude subscriptions.** The Agent SDK's usage gauge (`usage_EXPERIMENTAL…`) is read once per turn *after* the first content frame is out, off the response path, holding the prompt open past `result` so the CLI is alive for exactly one bounded control request; and once per logged-in subscription on the daily sweep through a turn-free query. Readings land in the same per-window buckets as `rate_limit_event`, labelled `utilizationSource: "continuous"`, never as a verdict. `CLAUDE_SDK_USAGE_GAUGE` (true), `CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS` (5000), `CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS` (60). The console had shown `—` for every window until one was nearly spent.
- **Checking on a subscription never spends usage.** The idle sweep's billed keepalive turn is opt-in (`IDLE_ACCOUNT_PROBE_PAID_TURN`, default `false`); the free `claude auth status` check still runs daily over every subscription. Login completion triggers no probe and no test.
- **`/v1/models` lists the subscription pool.** Claude subscriptions contribute their models — the SDK's `supportedModels()` through a turn-free query, else the shipped Claude table — deduplicated across accounts, alias rows (`opus`, `sonnet`, `haiku`, `fable`) carrying `resolved_model`. A key scoped to six `anthropic-oauth` accounts had answered `{"data": []}`. Migration `0024_model_catalog_source`.
- Tests: `login/status.ts` (the `claude auth status` probe) now has its own suite; the connect flow asserts a completed login clears the live verdict and spends no turn.

## [2.8.0] — 2026-09-05

### wire

- **Claude Code turns are served on translate egress instead of refused.** A cross-dialect hop toward OpenAI now *drops and reports* what the target cannot represent — Anthropic server-side and built-in tools (`web_search_*`, `tool_search_tool_*`, `bash_*`, `text_editor_*`), a `tool_choice` naming one, non-text `document` blocks, `server_tool_use` / `web_search_tool_result` / unknown block types, non-text blocks nested in a `tool_result` — on one `translation dropped fields` warn line per conversion, instead of answering `400 translation_failed`. A `text`-source document travels as text; an image inside a `tool_result` is hoisted into user content after the tool message rather than refused. `400` is reserved for a body that is not a valid Anthropic request. Production had counted 213 such refusals in one week from one Claude Code key.
- **The `request failed` line says why.** A `RouterError`'s scrubbed cause chain (`error`) now rides the line beside `errorClass`/`errorCode`; a translation refusal names its field in the log, not only in the response body.
- **The `upstream attempt failed` line carries the classifier's `signal`, the router's `reason`, and the upstream's own `upstreamMessage`** (bounded by `LOG_REASON_MAX_CHARS`, scrubbed). A subscription pool failing every request had logged `status 502 failureKind server-error` and nothing else.
- **A chain whose every attempt timed out answers `504 upstream_timeout`**, not `503 no_healthy_account` — the timeout is a verdict about a pool that was reached, and the rank table had held the slot for it all along. Connect failures still contribute nothing.
- **Upstream SSE keepalive comments are forwarded on translate egress.** `: OPENROUTER PROCESSING` and friends reached the parser and stopped there, leaving the client a silent socket for exactly the long-TTFT window the upstream was covering. They now go out as comment lines ahead of each chunk's frames, and never count as the first byte.
- **No-candidates messages account for every rejected member (#88).** `2 of 3 accounts … are rate limited (zai, minimax)` now continues `; 1 more needs a human (kimi needs re-auth)`; `disabled` / `needs_reauth` and `model-unsupported` rejections each get a clause, and the all-recoverable case renders exactly as before. Which error class wins is unchanged.
### sdk

- **Fixed:** a Claude subscription whose refresh token had expired was answered as `502` "a reason this router does not recognize" and failed over through every other subscription, while the account read `active` for a week. The renderer now raises a `result` message with `is_error: true` as a real failure (`SdkResultError`, carrying the SDK's `api_error_status` and `terminal_reason`), and the classifier reads every CLI spelling of a dead credential (`Failed to authenticate: OAuth session expired and could not be refreshed`, `Not logged in`, `Please run /login`, `Invalid API key`, `authentication_error`) as `auth` → `401` → `needs_reauth`. (#6 in the deep-dive)
- **Fixed:** `GET /api/admin/usage` answered `500` once a window's token sum crossed 2^31 (`integer out of range` — production measured 4.7 billion cache-read tokens over seven days). Usage aggregates now sum through `float8`, exact to 2^53. (#5)
- **Changed:** the daily `idle_account_probe` tick runs the free `claude auth status` check over **every** subscription account, idle or not, so an expired subscription flips to `needs_reauth` within a day; per-account structured log lines; `partial` now means "cut short" rather than "an account needs a human" (29 consecutive silent partials before), and a sweep that throws records `failed` with its cause. Documented the operator fact behind it: a Claude subscription's refresh token hard-expires ~30 days after login regardless of use — only a re-login moves it.
- **Added:** `sdk_transcript_sweep`, a scheduled task removing the `<session>.jsonl` and `<session>/` artifacts the `claude` CLI leaves under each Account's `CLAUDE_CONFIG_DIR` once older than `RETENTION_SDK_TRANSCRIPT_HOURS` (default 24 h; cadence `SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES`, default 60). Pure planner, bounded batch, symlinks never followed, nothing outside the two artifact shapes ever a candidate; a resume onto a swept transcript is a `stale-session` replay, never a failed request. Migration `0022_sdk_transcript_sweep`.
- **Added:** Agent-SDK failure classes for an oversized prompt (`400`, no failover, no breaker strike), a router CLI older than the requested model (`400`, naming the image), an overloaded upstream (`529`, retryable — previously `unknown`, which failed the request outright), the credits-era wordings (`you've reached your <tier> limit`, `you're out of usage credits` → `429`; `organization is out of usage credits`, `usage limit is set to $N` → `402`), a vanished fork point (`No message found with message.uuid` → `stale-session`), and the SDK's structured `api_error_status` as the fallback after every phrase.
- **Changed:** `@anthropic-ai/claude-agent-sdk` `^0.3.220` → `^0.3.261` (bundled CLI 2.1.261). The security gates (`settingSources: []`, empty named allowlist, `canUseTool` deny-by-default, `ANTHROPIC_*` stripped) and the CLI resolution ladder re-verified against it; one type break in the passthrough tool definition fixed. `resumeDropsTurn`, `permissionPrompts: 'none'`, and `user_message_uuid` evaluated and deliberately not adopted (see docs/idea/11).
- **Wired:** `LOG_REASON_MAX_CHARS` into the dispatcher's `log.reasonMaxChars` (bounds the scrubbed upstream text on the `upstream attempt failed` line) and documented it in the env reference.

## [2.5.0] — 2026-08-02

A deep-dive sweep across routing, the Agent SDK layer, usage accounting, the database layer, and the operator console, driven by five parallel audits of the areas v2.4.0 touched.

### Added

- `x-router-session-restart` response header: when a bound session is rebound off a cooling account (preflight) or failed over mid-chain, the response says so — the loss of upstream-side resumability is surfaced, never silent.
- `ROUTING_UNKNOWN_RESET_RETRY_AFTER_SECONDS` (default 30): the `Retry-After` answered when every candidate is out for a clock-recoverable reason but no reset instant is known. Replaces a hard-coded 1-second floor that invited a retry storm.
- Busy-session retry-as-fork on the Agent SDK path: two concurrent turns resuming one SDK session no longer fail over to a cold account — the loser retries once in place with a session fork, full history intact.
- Images nested in `tool_result` blocks are forwarded to the model (hoisted to sibling content blocks) instead of being silently dropped; `image/jpg` is normalized to `image/jpeg`; an image the router cannot forward is named in place (`[image omitted: …]`) instead of a generic label.
- Accounts table shows per-account last-used time (the column v2.4.0 unbroke); account edit dialog gains per-window token-limit ceilings, making the measured quota bars reachable for the first time.
- `describeError` in `@multi-ai-router/core`: every error log walks the cause chain innermost-first (AggregateError included), so a driver's complaint is never hidden behind a wrapper's statement text again — the failure mode that kept the `last_used_at` bug invisible. Six wrapper-only log sites converged on it.
- Live-database integration tests for every raw-SQL repository method that had none (`findIdle`'s NULLs-first ordering, usage series/breakdown/latency/totals), plus a mechanism probe pinning the raw-`Date` bind failure the v2.4.0 fix corrected.

### Fixed

- **Rebind is never worse than `fail`.** A rebind that finds no replacement account no longer destroys the session binding — the whole-pool-cooling case now answers the same honest `429` + `Retry-After` as `fail` mode with the binding kept, and the post-reset retry resumes warm. Rebind also no longer fires on a probe-in-flight hold, and the blocked 429 names the real reason with estimated resets labeled as such.
- **A concurrent rate-limit can no longer demote a dead account.** `recordFailure` now refuses to overwrite a terminal verdict, so an `exhausted` account keeps its `402`/"needs top-up" instead of gaining a countdown and timer retries.
- **SDK-path 429s carry `Retry-After`.** The reset instant delivered by the stream's `rate_limit_event` now reaches the error response instead of being dropped at classification.
- **A mid-turn upstream error on a non-streaming SDK request fails over.** It was relayed as a 502 while recording *success* on the account — no failover, failure streak reset. Zero bytes had reached the client, so trying the next pool account is honest and now happens. Subprocess crashes are also no longer collapsed into "no healthy account".
- **Credit-balance exhaustion on the SDK path classifies as `402`/`exhausted`** (string sourced from the vendored CLI), no longer retried on a timer as if rate-limited.
- Token accounting on tool-call turns: input and cache-read counts are no longer lost on early-stopped turns — the dominant agent-traffic shape under-reported systematically.
- Concurrency permits can no longer leak when a launch fails before the subprocess exists (a leak that silently wedged an account); session-binding writes are serialized per key so a rebind's clear can never land after its new bind.
- The console no longer claims a window-spent account is "Eligible for routing": the routable count and status cell subtract accounts blocked by a spent quota window. Unmeasured latency renders as "—", never "0 ms". Audit log updates after the mutations it records. Quota gauges no longer rebuild every element on each 30-second tick.
- `context_management` (an SDK-only field stock Anthropic clients crash on) is stripped from forwarded stream events; `ENABLE_CLAUDEAI_MCP_SERVERS=false` and `CLAUDE_CODE_SESSION_KIND=bg` are forced on SDK subprocesses (the connectors door is not covered by `strictMcpConfig`; the scratchpad block advertised a router-internal path).
- Boot-migration failures log the actual Postgres complaint (cause chain) through a credential scrubber — the migrate-time logger previously wrote unredacted and wrapper-only.
- Raw-SQL convention: un-cast bind parameters in usage read/rollup queries gained explicit casts; `width_bucket` can no longer be reached with a non-positive slot count.

### Changed

- Dependencies: hono 4.12.33, drizzle-orm 0.45.2, @hono/zod-validator 0.9.0, biome 2.5.6, vite-plugin-solid 2.11.14. (`@anthropic-ai/claude-agent-sdk` 0.3.220 was already latest. Major bumps — TypeScript 7, solid-router 1.0, Vite 8 — deliberately deferred.)
- Log limits and intervals became config: `LOG_REASON_MAX_CHARS` (200), `USAGE_LOG_REPORT_INTERVAL_MS` (60000).
- `ADMIN_OIDC_CLIENT_SECRET` and `ADMIN_API_TOKEN` added to the SDK subprocess env strip list (defense in depth).
- Usage recorder: shutdown flushes late-enqueued records and counts anything a refusing writer stranded; log throttling reports trailing counts instead of under-reporting bursts forever.

## [2.4.0] — 2026-08-02

### Added

- `ROUTING_BOUND_ACCOUNT_COOLING_DOWN` chooses what happens when a session is bound to an account that is merely cooling down: `fail` (the default, unchanged behavior — `429` + `Retry-After`, binding kept) or `rebind` (invalidate the binding and start fresh on another eligible account). `rebind` suits pools with more than one account and clients that resend full history every turn, where the abandoned upstream resumability costs nothing and a spent window stops hard-blocking the session. The routing layer already knew both options; until now no config selected one.

### Fixed

- `last_used_at` stamping worked again — `markUsed` interpolated a raw `Date` into a raw sql template where no column encoder applies, so postgres.js refused it at bind time and every stamp since 1.2.0 silently failed, leaving every account's `last_used_at` NULL and making the idle probe treat busy accounts as never-used. The instant is now bound as an ISO string with an explicit `::timestamptz` cast, and a live-database integration test covers the stamp.
- A refused usage write logs its cause chain innermost-first, not just drizzle's "Failed query" wrapper — the wrapper's statement text had hidden the actual client-side bind failure inside the 200-char budget for days.

## [2.3.2] — 2026-08-01

### Fixed

- Dialogs are wider, and width is now a named size on the shared `Modal` rather than one hardcoded number. The panel was pinned at `34rem`, a width chosen for a one-sentence confirmation and then inherited by the account, pool and key forms — which are two-column and dense, so labels wrapped, member lists were squeezed, and a pool with five accounts rendered as a column of ellipses. `sm`/`md`/`lg` (40/56/76rem) are set as a custom property in one stylesheet; every dialog is wider than before, and the dense forms are much wider.

## [2.3.1] — 2026-08-01

### Fixed

- A completed SSO sign-in returns to the console instead of ending on a "you can close this tab" page. The callback was a dead end, so the operator finished the login by hand. It now navigates to `/` — client-side rather than as a `302`, because this response is the tail of a cross-site chain that began at the identity provider, and a server redirect can arrive without the `SameSite=Strict` session cookie the response just set, bouncing back to `/login` as though the sign-in had failed. A visible link is the no-JS path.

## [2.3.0] — 2026-08-01

### Fixed

- A rejected admin sign-in now leaves a record. The `/oidc/callback` route renders its own HTML and therefore never reached the error handler, so the only trace of a failure was an unstructured `console.error` on stdout — no level, no `requestId`, invisible to a log aggregator, and the sole `console.*` call left in the router. It is now a structured `warn` line (`component: "admin-auth"`, the diagnostic `reason`, the request id) plus an `admin.login_failed` audit row with `method: "oidc"`, which the password path has always written and this one never did. The browser still receives only the one generic sentence.
- A failed token exchange reports the endpoint's HTTP status as its diagnostic instead of being folded into an unlabelled `auth` kind. The response body is deliberately not logged: some providers quote the authorization code and client secret back inside it.

### Changed

- `ADMIN_OIDC_ADMIN_EMAIL` is a comma-separated allowlist. A self-hosted router is normally run by a team, and pinning one address meant every other operator shared a credential or could not sign in at all. Entries are trimmed, lowercased, and deduplicated at boot; a value naming no email (`","`) is refused at boot rather than left to fail every login. This is not multi-user: there are still no user rows, no roles, and no per-person state — every entry maps onto the same single admin principal.
- The admin session and its audit rows carry the email the identity provider actually asserted, not the configured value. With one allowed address the two were the same string; with several, using the configured list would attribute every session and every logout to whichever entry sorted first.

## [2.2.0] — 2026-07-31

### Fixed

- Split spend into its own **COST** column on the accounts and keys tables (#65).
- An unread quota window reads "no reading yet" rather than claiming the provider exposes no signal (#69, #70).

### Changed

- Declared `policy.defaultTier` GREEN so a merge to `main` never deploys (#66).
- Hardened two live-Postgres suites against cross-test interference: the admin credential is evicted and restored rather than the table wiped (#64), and `scheduled_task_runs` is cleared before the last-run assertion (#61).

## [2.1.0] — 2026-07-30

### Added

- Optional local admin password login alongside OIDC — an argon2id hash set by `bin/admin set-password`, off by default, fail-closed on a non-loopback `PUBLIC_URL` (#52, #59).

### Fixed

- The ten confirmed findings from the 2026-07-30 frontend audit (#58).
- `bin/lint` on `main`: `.claude/**` is excluded from Biome.

### Changed

- Completed the admin OIDC rollout and its documentation (#47), and corrected the README claims the new intro still got wrong (#53, #56).

## [2.0.3] — 2026-07-30

### Changed

- Added bounded server-side diagnostic kinds for failed admin OIDC callbacks. The browser still receives one generic verification failure, while operators can distinguish discovery, JWKS, token-claim, principal, and state failures without logging token or claim material.

## [2.0.2] — 2026-07-29

### Fixed

- Widened the shared OAuth-state provider column to text so the internal `admin-oidc` state namespace can coexist with code-defined upstream provider ids without pretending the admin identity provider is an inference provider.
- Repaired the Drizzle migration journal so the widening migration is applied by the runtime migrator.

### Changed

- Relabeled the console action from **Sign in with OIDC** to the operator-facing **Sign in with SSO**.

## [2.0.1] — 2026-07-29

### Changed

- Shipped the SSO button relabel. This release retained the OAuth-state enum mismatch fixed in 2.0.2 and should not be deployed.

## [2.0.0] — 2026-07-29

### Breaking

- Removed `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `ADMIN_PASSWORD_HASH`. The router no longer ships a local password-login path. Existing deployments must register an OIDC client and configure the required `ADMIN_OIDC_*` values before upgrading; boot fails closed when the relying-party configuration is incomplete.
- Removed `POST /api/admin/auth/login`. Browser authentication now starts at `GET /api/admin/auth/oidc/start` and returns through `/api/admin/auth/oidc/callback`.

### Added

- Generic admin OpenID Connect discovery, authorization code exchange, PKCE S256, JWKS caching, RS256 ID-token verification, nonce validation, verified-email enforcement, and optional immutable subject pinning ([#42](https://github.com/developerz-ai/multi-ai-router/pull/42)).
- One-shot, ten-minute admin OIDC state built on the existing OAuth-state repository.
- OIDC-only console login and a callback result page.
- Provider-agnostic setup and security documentation in [`docs/idea/13-admin-oidc.md`](docs/idea/13-admin-oidc.md).

### Changed

- Admin browser sessions are issued only after the IdP-asserted email matches `ADMIN_OIDC_ADMIN_EMAIL`; `ADMIN_OIDC_ADMIN_SUBJECT` can add an exact `sub` match.
- Login throttling now protects OIDC start and callback by client IP rather than a local username/password attempt.
- `bin/setup` points operators to the OIDC setup contract instead of generating local admin credentials.
- `ADMIN_API_TOKEN` remains the independent, auditable break-glass path for scripts and IdP outages.

## [1.4.1] — 2026-07-28

### Fixed

- **`GET /v1/catalog` answered `data: []` for the first hour after a deploy.**
  Every scheduled task waits one full jittered interval for its first tick, which
  is right for a sweep that deletes rows — nothing is looking at it. The model
  catalog is the first task here whose output someone can *see missing*, and an
  hour of an empty listing is indistinguishable from a broken endpoint. Caught by
  calling the endpoint on production rather than by a test, because no test
  asserted a thing nobody had thought to want yet.

  Tasks may now state a `startupDelayMs`; the catalog asks for thirty seconds and
  nothing else asks for anything. It is the **first gap only** — a task that kept
  using it would run on a cadence nobody configured, which for a sweep making
  outbound requests is a self-inflicted rate problem. Both halves are asserted.

## [1.4.0] — 2026-07-28

### Added

- **A model catalog, refreshed hourly, with each model's context window.** Every
  account's upstream is asked what it serves and the answer is stored with how
  much fits in each model — the data behind the new catalog endpoint and the
  console's model column. It costs nothing to run: a model listing spends no
  tokens and no quota window, unlike the keepalive sweep beside it.

  **It writes a description, never a routing decision.** `supported_models` — the
  column that decides which accounts a request may land on — stays operator-owned
  and is untouched by any timer, exactly as its own note has always said. The new
  `model_catalog` table is read by nothing in selection, which is what lets it
  refresh itself at all: an upstream retiring a model changes what the router
  *says* and never where a request goes.

  Skipped for Claude subscriptions (the Agent SDK owns that catalog and there is
  no endpoint to GET), for `openrouter` (an aggregator of several hundred models
  it does not itself serve), and for accounts the operator disabled. The batch is
  ordered **oldest catalog first**, so a fleet larger than one tick rotates
  through rather than refreshing the same few forever.

- **Context windows for the providers whose listings state none.** Verified
  against the live endpoints rather than assumed: z.ai, MiniMax, OpenAI and
  Anthropic all answer `/v1/models` with an id, an object type and an owner and
  nothing else. Those windows now ship in a pinned table with a date, structured
  exactly like the price tables next door. Google, Mistral, Groq, Together and
  Cerebras are deliberately absent — their listings carry a real size, so the
  parser reads a live number and a shipped row would only be a staler copy.

  Every window is labelled `upstream` or `shipped` wherever it is rendered. Both
  are real published figures; only one can know about a model released after the
  image was built.

- **`GET /v1/catalog` and `GET /v1/providers`** — this router's own listings, with
  context window, price, and how many accounts stand behind each model. Same
  router key, same scope intersection, and the model set comes from the same
  implementation `/v1/models` uses, so the two can never disagree about what a key
  can reach.

  A **passthrough account contributes here and not to `/v1/models`**, which is the
  point of having both: an account declaring no `supported_models` serves any name
  and therefore advertises nothing enumerable, while its upstream has told the
  sweep exactly what it serves. `null` means unknown in every numeric field —
  never zero, never unlimited.

- **A consumption sparkline beside the quota bar.** Two windows both two-thirds
  spent look identical until one of them shows the whole two-thirds went in the
  first hour, and only one of those is about to run out. It is the same
  measurement as the bar — the total is the sum of the slices, from one query —
  and it appears only where the bar is the router's own count, never beside a
  provider-reported percentage.

### Fixed

- **Claude Opus 5 priced as unknown, so subscription usage reported `$0`.** The
  Anthropic price table stopped at the 4.x families. Opus 5, its fast variant, and
  the 4.x models below 4.6 are all named now, along with **Sonnet 4.5 — which the
  keepalive sweep itself sends**, so until now every turn this router billed
  itself priced as free.

  Fast-mode variants are priced **by name, never by multiplying the base model**:
  Opus 4.7 fast bills at 6× its base and Opus 4.8 and 5 fast at 2×, so a derived
  rate would have over-reported one family threefold.

## [1.3.2] — 2026-07-28

### Fixed

- **`GET /api/admin/accounts` answered `500` whenever any account had a token
  ceiling configured.** The measured-usage query aliased a column `window`, which
  is a **reserved keyword** in Postgres (it introduces a window-function clause),
  so the whole statement was a syntax error. Every caller was unit-tested against
  a stub, so nothing caught it until the live console broke. The column is
  `window_kind` now, and a new integration test runs the real statement against a
  real PostgreSQL — the only thing that could have caught this.

## [1.3.1] — 2026-07-28

### Fixed

- **`windowTokenLimits` rejected every realistic map.** Zod treats a record keyed
  by an enum as *exhaustive*, so setting a ceiling for one window answered
  `seven_day_opus: expected number, received undefined` and demanded all five
  kinds. A plan has one or two windows an operator cares about, so a partial map
  is the normal case — `partialRecord` now.

## [1.3.0] — 2026-07-28

### Added

- **A usage progress bar for windows the provider never reports on.** Anthropic
  publishes no numeric quota limit and its SDK sends a `utilization` only when a
  window is already near its edge — so for most of every window the console had
  an empty gauge and an em-dash. An account can now carry operator-set token
  ceilings per window (`windowTokenLimits`), and the console fills the bar from
  tokens **this router measured** against them.

  Two rules keep it honest. The provider's own reading always wins when it
  exists — the measured fraction is only a fallback, never an override. And the
  bar says what it is: measured by us, against a limit you chose, from a provider
  that counts differently. **Nothing in routing reads it** — a guess about
  someone else's accounting must not decide which account serves a request.

  Usage is counted from the window's **own** span (`resetsAt - span`), not from
  "N hours ago": a five-hour window resetting in twenty minutes opened 4h40m ago,
  and the two ranges differ by exactly that much.

## [1.2.0] — 2026-07-28

### Added

- **An idle-account keepalive sweep.** A Claude subscription's tokens are
  refreshed by the Agent SDK, but only *when it runs* — the access token lasts
  hours and the refresh token weeks, so a subscription nobody routes to is not
  idle, it is expired, and the operator finds out at the moment they needed it.
  A daily task now spends one real, billed request on any account unused for
  `IDLE_ACCOUNT_AFTER_DAYS` (default 7). The request *is* the refresh.

  It asks the `claude` CLI whether the account is still logged in **first** —
  free, contacts no provider — and for one that answers "logged out" it marks
  `needs_reauth` and **skips the billed turn entirely**: that test would fail for
  a reason only a human can fix, and paying to re-learn a fact we hold is a slow
  leak rather than a keepalive.

  Cost is bounded by the *threshold*, not the interval: testing an account counts
  as using it, so each account is touched about once per idle window. Bounded per
  tick, resumable, and abort-checked between accounts so a shutdown never lands
  mid-turn.
- `accounts.last_used_at`, stamped by the usage recorder's existing background
  drain (never on the request path), so "has this account gone unused" is one
  indexed question rather than a scan of a table retention prunes.
- `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES`, `IDLE_ACCOUNT_AFTER_DAYS`,
  `IDLE_ACCOUNT_PROBE_BATCH_SIZE`.

## [1.1.4] — 2026-07-28

### Fixed

- **A spent Claude plan window was not classified at all.** The wording a plan
  actually uses — `"You've hit your weekly limit · resets Jul 30, 11pm (UTC)"` —
  shares no phrase with the rules that existed, so it fell through to
  `UNCLASSIFIED`: an unknown failure for the single most ordinary thing a pooled
  subscription does. It now reads as `rate-limited` (`cooling_down` + `429`),
  never `auth`, which would have parked a perfectly good subscription at
  `needs_reauth` for a window a clock reopens.

## [1.1.3] — 2026-07-28

### Fixed

- **The failed-test log recorded the router's own words, not the upstream's.**
  1.1.2 logged a failed "Test now", but logged the router-authored message — so
  an upstream failing for a reason this build has no rule for was recorded as
  "the Claude Agent SDK failed for a reason this router does not recognize". A
  tautology, and a dead end for whoever has to write the missing rule. The probe
  now carries the upstream's verbatim text through to the log line (never to the
  response body, which is a contract with the console).

## [1.1.2] — 2026-07-28

### Fixed

- **The quota reading "Test now" ingested never reached the console.** 1.1.1 folded
  the turn's `rate_limit_event` into the SDK quota store, but the console and
  routing both read a *health snapshot*, so the reading landed somewhere nothing
  renders and the windows stayed as stale as before. The resulting signal is now
  folded into the health store too — the same hop the dispatch path makes.
- **A failed "Test now" left no trace anywhere.** Its message is router-authored
  by design, so when an upstream fails for a reason this build has no rule for,
  the only copy of what it actually said was the one being discarded — a dead end
  for the operator and for whoever has to write the missing rule. A failed test
  now logs the provider, model and reason at `warn`.

## [1.1.1] — 2026-07-28

### Fixed

- **Every Claude subscription reset instant was being discarded.** The Agent SDK
  reports `rate_limit_info.resetsAt` in epoch **seconds** (verified live against
  SDK 0.3.220); the router read it as milliseconds, landing it in 1970, where it
  failed the "still in the future" check and was dropped as stale. That silently
  cost the whole subscription reset surface — no per-window countdown in the
  console, `resetSource: "unknown"` instead of `provider-reported`, and a circuit
  breaker estimating a backoff while holding the provider's exact answer. Both
  units are now accepted, so an SDK that switches to milliseconds cannot re-break
  it in the other direction.
- **"Test now" billed a turn and threw away the quota reading it paid for.** The
  SDK volunteers `rate_limit_event` on every query, not only near a limit. The
  probe ignored it, so an account's quota windows stayed empty until unrelated
  traffic happened to route through it — backwards for the one button whose job
  is answering "how is this account doing". The readings now land in the same
  store the dispatch path writes to.
- **A spent Claude subscription reported "the Claude Agent SDK turn did not
  succeed (success)".** That failure arrives as `subtype: "success"` with
  `is_error: true` and the reason in `result`; the probe rendered the subtype and
  discarded the reason. It now reads the stated reason through the same
  classification table the data plane uses, so a spent window says so.

## [1.1.0] — 2026-07-27

### Added

- `ADMIN_API_TOKEN` — a bearer credential for `/api/admin/**`, so the admin API
  can be driven by a script, a CI job, or an agent rather than only a browser
  session. Unset by default, which leaves the plane browser-only. Boot refuses a
  token under 32 characters (nothing rate-limits this credential the way the
  browser OIDC start/callback is throttled) or one wearing the `mar_live_` router-key prefix (the
  admin guard rejects that prefix outright, so it would authenticate nothing).
  Router keys still cannot reach the admin plane under any configuration.

### Fixed

- **Kimi: a spent billing cycle disabled the account permanently.** Kimi
  announces it as `403 permission_error`, which fell through to the status
  default `auth` — and an `api-key` account's auth failure parks at `disabled`,
  a state no timer lifts. An operator had to re-enable a credential that was
  never broken, for a quota Kimi refills on its own clock. Now classified
  `rate-limited` off the wording, so the genuine `permission_error` still reads
  as an auth failure.
- **z.ai: a spent weekly plan window was re-probed every five minutes.** z.ai
  reports the reset instant only inside the error message — no `retry-after`, no
  `x-ratelimit-*` — so the breaker fell back to its backoff, capped at five
  minutes, against a window with days left to run. The instant is now parsed and
  reported as `provider-reported`, and `1310` is pinned as its own signal.
- `GET /api/admin/auth/session` no longer risks a `RangeError` when rendering a
  session with no expiry.

## [1.0.0] — 2026-07-26

First stable release. Multi AI Router is a self-hosted proxy: point your tools
at one OpenAI/Anthropic-compatible endpoint, and it fans out across whatever
pool of provider accounts and API keys you've given it — several Claude
subscriptions side by side, a mix of OpenAI-compatible vendors, local Ollama —
picking a healthy account per request and failing over without you touching
your tooling config.

### Added

- Full data plane: `/v1/messages`, `/v1/chat/completions`, `/v1/responses`,
  `/v1/messages/count_tokens`, `/v1/embeddings`, `GET /v1/models/:id` — with
  cross-dialect translation (OpenAI ⇄ Anthropic) for streaming and
  non-streaming requests alike.
- Claude Max/Pro/Team subscriptions as a first-class provider, driven through
  `@anthropic-ai/claude-agent-sdk` with one `CLAUDE_CONFIG_DIR` per account,
  an explicit tool allowlist, and passthrough-only tool execution on the
  client — the router never runs a tool on its own host.
- ChatGPT/Codex OAuth and 17 provider drivers total, including six
  OpenAI-shaped vendors, native Gemini over Google's OpenAI-compatible
  surface, and Ollama with optional (no-auth) local endpoints.
- Routing: filter → policy → failover chain, health snapshots, circuit
  breaker, `cooling_down` vs `exhausted` distinction (429+`Retry-After` vs
  402), per-account "Test now" real completion probe.
- Router keys: named, encrypted at rest, viewable/copyable any time (no
  "shown once" flow), scope enforced as pool-members ∩ key-scope, per-key
  rate limits.
- Admin plane: full CRUD for accounts, pools, and keys; OAuth connect flows
  for Claude subscriptions and ChatGPT/Codex; guided onboarding walk from
  zero accounts to a working key with copy-paste client snippets (Claude
  Code, Cursor, Codex CLI, Aider, OpenAI SDK, curl).
- Operator console (SolidJS SPA): usage totals per key/account/pool/model
  windowed today/7d/30d/custom, live request feed, quota gauges, top-N,
  inline sparklines, dark-first design tokens — served from the same origin
  as the API, no CORS.
- Scheduler: in-process jittered timers with `pg_try_advisory_lock` per task
  — usage rollup, OAuth-state purge, quota-floor recovery — every task
  idempotent, resumable, bounded-batch, with `ScheduledTaskRun` visibility.
  No broker, no cron, no refresh timer for Claude subscription tokens.
- 11 Drizzle migrations, Postgres 16+ via `postgres.js`.
- Observability: structured JSON logs with request-id propagation and a
  tested credential redactor, Prometheus-style `/metrics` including
  `router_overhead_seconds`, `/healthz` and `/readyz`.
- `bin/bench`: overhead-measurement harness (p50/p95/p99 + added
  time-to-first-token vs a stub upstream), wired as a non-blocking CI report
  against a committed baseline.
- Multi-arch (`amd64`/`arm64`) container image published to
  `ghcr.io/developerz-ai/multi-ai-router` on release tags, `docker compose up
  -d` starting router + Postgres with a health-gated startup.
- `SECURITY.md` with coordinated disclosure, `.github/SETTINGS.md` for
  repo-config guidance.

### Fixed

- **A recovering account now takes exactly one probe, not the whole backlog.**
  The circuit breaker's half-open state promised "one request through as a
  probe", but nothing admitted one: the reset instant passing made the account
  eligible to every waiting request at the same millisecond, so everything that
  queued up during a five-minute cooldown dispatched at it together and rate
  limited it again. One request is now admitted; the rest are dropped as
  `probe-in-flight` and answered `429` with the hold's expiry. The operator's
  **Re-check now** joins the same gate rather than adding a second recovery
  path.
- **`ROUTING_FAILURE_THRESHOLD`, `ROUTING_BASE_BACKOFF_MS`, and
  `ROUTING_MAX_BACKOFF_MS` now reach the breaker.** All three were parsed at
  boot, documented in the environment reference, and read by nothing — the
  breaker silently ran its module defaults. Backoff is also jittered now, so
  accounts tripped in the same second no longer return in the same millisecond
  and re-stampede whatever knocked them over. New `ROUTING_HALF_OPEN_HOLD_MS`
  bounds a probe that never reports.
- **A pool's overflow account can no longer sit outside the pool.** A key
  scoped to a pool used to reach that pool's overflow even when the account
  belonged to no pool the key names — spending it once every member cooled
  down, and advertising its models in `/v1/models`. Candidates are
  `pool_members ∩ key_scope` with no exception: the overflow is now one of the
  pool's own members, held back from the policy. The admin plane refuses a
  write that breaks the rule (`overflow_not_member`, `400`), including an edit
  that would drop the overflow's own membership; routing ignores a reference
  that predates it; migration `0010` backfills existing rows as memberships, so
  behavior is unchanged and the reach becomes visible in the pool's member
  list.
- A `<select>` in the console rendered its first option instead of the stored
  one — a pool on `round-robin` read as `sticky`, and one with an overflow read
  as "None".
- `router_overhead_seconds` no longer double-counts a successful attempt's
  own upstream wait time.
- Session-slide writes to the store throttled instead of firing on every
  request.
- Log redaction gaps closed for JWTs, connection strings, and vendor API
  keys, while still preserving diagnosable structure (host/path kept).
- SPA static-file serving hardened against path traversal, with the fallback
  route never shadowing a real, mounted API request.

### Documentation

- Full spec under `docs/idea/` (architecture, domain model, providers,
  routing/failover, protocol translation, security, observability,
  deployment, roadmap) reconciled against shipped behavior — no more "not
  implemented" framing for features that ship.
- README rewritten around the actual product story: your tools → Multi AI
  Router → providers.

[1.0.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v1.0.0
