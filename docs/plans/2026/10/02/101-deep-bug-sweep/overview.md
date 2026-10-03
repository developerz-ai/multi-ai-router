# Deep bug sweep — top to bottom (v2.15.0)

## Goal
Document every real bug in the router, from the edge to the console, plus what production shows, so `/feature` can fix them slice by slice. Nothing was fixed while planning.

## Context
- Read-only sweep of `main` @ `ad32f07` (v2.15.0): 4 parallel agents, two passes each (map + flow traces, then edge cases and uncovered internals), partitioned by the CLAUDE.md Layers table. Several findings were reproduced with scratch probes that are not in the repo. The rest are code-read, and anything unproven is labelled `unverified`.
- Production evidence: k3s pod log (~8 h) + `multi_ai_router` DB via `../infrastructure` ssh-wrapped kubectl. Slice 06.
- Stack: Bun 1.4 + TS strict, Hono, Zod, Drizzle over postgres.js, Agent SDK for Claude subs, SolidJS + TanStack Solid Query.
- **Security gate holds (checked, not assumed):** every Agent SDK launch uses the empty named allowlist and `settingSources: []`, and strips `ANTHROPIC_*`. A client tool named `Bash`/`Read` is only exposed as `mcp__client__*`, and every call is denied. No two accounts share a config dir. Same-dialect passthrough leaves the body untouched (only the model splice).

## Plan files (execute in order of the worklist; slices are path-disjoint except the contested paths below)
1. [`01-edge-auth-security.md`](01-edge-auth-security.md) — transport, dataplane orchestration, router-key + admin auth, headers, usage-row decisions. 23 findings.
2. [`02-routing-state-persistence.md`](02-routing-state-persistence.md) — routing/health/half-open, account refresh, catalog, scheduler, cost, rollups, **all `packages/db` + migrations**. 18 findings.
3. [`03-providers-claude-sdk.md`](03-providers-claude-sdk.md) — HTTP drivers, failure classification, rate-limit parsing, Agent SDK subprocess/quota/session. 17 findings.
4. [`04-translation.md`](04-translation.md) — cross-dialect conversion, streaming state machines, mid-stream error matrix. 19 findings.
5. [`05-web-console.md`](05-web-console.md) — operator SPA. 14 findings. All confirmed items from the 2026-07-30 audit are already fixed.
6. [`06-prod-observations.md`](06-prod-observations.md) — production evidence; each item points at the slice that owns the fix, plus 2 infra items for `../infrastructure`.

**Totals:** 0 critical · 14 high · 31 medium · 54 low. That is 99 entries, about 92 unique: 06.1–06.6 and 03.6 cross-reference fixes owned by other slices.

## Contested paths (one owner each)
| Path | Owner | Others needing it | Rule |
|---|---|---|---|
| `packages/db/**` (schema, repos, **migrations**) | 02 | 01 (`response_status` col 01.6, sentinel-model row 01.7, `body_read_ms` 01.1, update-only session `touch` 01.2) | Only 02 writes migrations; 01 sends column specs to 02. Land 02's migration PR first. |
| `services/dataplane/chain.ts` | 02 | 01.13 (abort ≠ timeout), 02.4/02.17 (zero-attempt exit) | One agent edits; 01.13 lands after 02.4. |
| `services/dataplane/quota-writer.ts` | 02 | 01.22 (writer `stop()` drain) | 02 takes 01.22 for this file; 01 keeps `status-writer.ts`. |
| `services/dataplane/plan.ts:156` | 01 | 01.15 also edits `providers/driver.ts`, `claude-sdk/driver.ts:71,96` (03) | 01 drops the call, then 03 removes `mapModelAlias` from the interface. |
| `scheduler/tasks/idle-account-probe.ts` | 02 | 03.13 (`kimi: "k2"`) | 02 edits. |
| `apps/api/src/routes/admin/accounts.ts` (status filter) | 01 | 05.2 needs live status from the API | 02.9 supplies the live status source, 01 exposes it, 05 renders it. |

## Ranked worklist (high + medium)
| # | Sev | ID | Defect |
|---|---|---|---|
| 1 | high | 01.15 | **NN 4:** the alias map is applied twice (`routing/filter.ts:122` + `dataplane/plan.ts:156`). A chained map sends a model routing never approved. Reproduced. |
| 2 | high | 01.13 | A client disconnecting before the first byte is classed as an upstream `timeout`. The chain retries with the aborted signal, so a few Esc presses strike and cool a healthy pool. |
| 3 | high | 01.14 | Bun `idleTimeout` 60 s kills any `stream:false` request that takes longer than 60 s. `UPSTREAM_TIMEOUT_MS=600000` is never reached for non-streaming calls, and it feeds 01.13. Reproduced on Bun 1.4.0. |
| 4 | high | 02.14 | The scheduler holds a pooled connection per running task. With due tasks ≥ `DB_POOL_MAX`, the pool deadlocks: usage writes, admin, session lookups and shutdown all freeze. At the default of 10, every other caller shares 1 connection. |
| 5 | high | 03.1 | One stale `rejected` SDK rate-limit bucket is never expired, so every later successful turn puts the Claude sub into cooldown. |
| 6 | high | 03.2 | When a stream stalls after the first byte, the `claude` subprocess is never killed. It holds its concurrency slot until the 600 s deadline. |
| 7 | high | 02.1 | In-memory `exhausted`/`needs_reauth` verdicts never expire. A Codex OAuth reconnect never clears them, and Re-check only clears the replica that served it. |
| 8 | high | 02.3 | Re-check and a Claude re-login restore the account as fully `active`, not as one half-open probe, so the whole backlog hits it at once. |
| 9 | high | 01.1 | `router_overhead_ms` counts the client's upload time, which explains prod's 82 ms avg (06.1). The metric is lying, so the NN 8 budget can't be enforced. |
| 10 | high | 04.1 | Responses → openai-chat: parallel `function_call`s become separate assistant messages, so OpenAI returns 400 on every turn after a parallel batch. Reproduced. |
| 11 | high | 04.2 | Anthropic → openai-chat: an image taken out of a `tool_result` splits the tool-message run, so a parallel batch with a screenshot gets a 400. Reproduced. |
| 12 | high | 04.3 | The router emits `reasoning` items, then refuses them with a 400 when the Responses client replays its transcript. Reproduced. |
| 13 | high [N>1] | 02.2 (=03.6) | Codex refresh is single-flighted only per process. Two replicas spend the same rotating refresh token, and the loser marks a live account `needs_reauth`. |
| 14 | medium | 03.11 | A `/v1/messages` body that fails schema on a Claude sub runs a **billed** empty-prompt turn and drops `stream`/system/tools. It should be a 400. Reproduced. |
| 15 | medium | 03.12 | OpenRouter's 403 (moderation-flagged input) is classed `auth`, so one flagged prompt parks every OpenRouter key in the pool. Reproduced. |
| 16 | medium | 03.4 | Compatible drivers ignore a reset time stated in the body (prod Alibaba: 2026-10-13). Nearby wording flips it to a permanent 402. Reproduced with the real body. |
| 17 | medium | 01.16 | A stream cut by an upstream error, the deadline or a client cancel is recorded as `success`, and the account is never struck. |
| 18 | medium | 01.17 | Headers are filtered by blocklist in both directions. Upstream org/project/rate-limit headers reach key holders, and client `OpenAI-Organization`/`-Project` headers reach the upstream. |
| 19 | medium | 01.4 | A key verification in flight during `revoke` re-caches the revoked key for the full TTL (60 s). |
| 20 | medium | 01.2 | Logout can be undone: a fire-and-forget session-slide `upsert` that lands after the `delete` restores the session. |
| 21 | medium | 01.3 | The login lockout is checked before the argon2 await, so parallel guesses all get through. There is no cap on concurrent verifies. |
| 22 | medium | 01.5 | Unauthenticated `/oidc/start` writes a row per hit with no throttle (the docs claim one). The discovery/JWKS fetch has no timeout. |
| 23 | medium | 02.4 | Losing the half-open race returns `503` with no `Retry-After` and writes no `UsageRecord`. |
| 24 | medium | 02.15 | A failed half-open probe below the failure threshold leaves the account half-open, so the next request probes it again. |
| 25 | medium | 02.5 | A catalog refresh after an admin write can join a stale in-flight load (read-after-write broken). |
| 26 | medium | 02.6 | The daily rollup double-counts failover requests across accounts. |
| 27 | medium | 02.7 | Kimi coding-plan models (`k3`) and every `openai-compatible` model (`qwen3.8-max`) cost `unknown`. That is 630 of ~2.7k successes in 7 d (06.2). |
| 28 | medium | 03.3 | Busy-session retry: the first attempt's late epilogue releases the retry's concurrency slot. |
| 29 | medium | 03.5 | MiniMax `200` + `base_resp` failure (out of balance) is never classified; `attempt.ts:101` skips 2xx. |
| 30 | medium | 04.4 | Responses → openai-chat stream: an upstream failure leaves no terminal chunk and no `[DONE]`. It is the only direction in the 6-way matrix that fails this way. |
| 31 | medium | 04.5 | Streamed Responses refusals (`response.refusal.delta`) are dropped. |
| 32 | medium | 04.6 | A `function_call_output` with an image is a 400 on every non-Responses egress. |
| 33 | medium | 04.7 | Chat → Anthropic: tool calls with a `finish_reason` other than `tool_calls` report `end_turn` (upstream behaviour `unverified`). |
| 34 | medium | 04.16 | An index-less upstream repeating the call `id` per chunk gets one `tool_use` block per fragment. Probe confirmed; which upstreams do this is `unverified`. |
| 35 | medium | 05.1 / 05.2 | The Pools screen counts cooling members as routable, and the Accounts filter uses stored status while rows show live status. The source is 02.9. |
| 36 | medium | 05.10 | The Lifetime usage chart plots 1970–1971 and is always empty. The API side belongs to 02. |
| 37 | medium | 05.3 | A half-filled key rate limit silently becomes "no ceiling". |
| 38 | medium | 05.4 | Redirect connect shows "Connected" on any row change, even when the refresher wrote `needs_reauth`. |
| 39 | medium | 05.5 | Account row actions fail silently, and a failed Test keeps showing the last success. |
| 40 | medium | 06.3 / 06.4 → 01.6 / 01.7 | Router-refused requests: `http_status` NULL; authenticated 400s write no usage row. These need a decision (below). |

Lows: see each slice. Worth batching: 03.7 (alias lookup resolves `__proto__`-style keys), 03.8 (`Retry-After: 0`), 03.10 (env strip misses provider-switch/Sentry vars), 01.19/01.20 (unscrubbed, unbounded upstream error bodies), 01.21 (drain-deadline streams lose their usage row).

## Causal chains / cross-slice
- **01.14 → 01.13 → 02.x:** a non-stream call over 60 s is cut by Bun. The client sees a disconnect, the router classes it as an upstream timeout and strikes every account in the chain. The breaker opens, and with 02.3/02.15 recovery is either a stampede or stuck half-open. Fix 01.14 + 01.13 first, since together they turn slow requests into pool-wide cooldowns.
- **03.1 + 02.1:** both leave an account parked after it recovered: a stale SDK bucket (Claude) and a sticky in-memory verdict (Codex/metered). The operator sees "cooling" with no reason. 05.1/05.2/05.12 then display it inconsistently.
- **01.1 hides real regressions:** until overhead excludes the upload, `router_overhead_seconds` and `bin/bench` cannot catch a real NN 8 violation in prod.
- **01.16 + 02.6 + 02.7 → usage numbers wrong three ways:** broken streams counted as success, failovers double-counted in rollups, and ~24 % of successes cost-less.
- **02.14** shows up as a hung shutdown or a stuck console in any slice's symptom. Suspect it first when "everything froze after downtime".

## Decisions the executor must take (surface in the PR, don't guess silently)
- 01.6: add a `response_status` column (recommended) vs close "http_status = upstream status" as by-design in `08-observability.md`.
- 01.7: record a sentinel-model row for authenticated pre-model 400s (recommended — CLAUDE.md says one row per request) vs document the exclusion.
- 03.11: a 400 is right; also decide whether dropping `temperature`/`stop_sequences` should start returning an error. The spec documents ignoring them, so change the spec first or keep the behaviour.

## Falsified doc claims (fix in the same PRs)
- `CLAUDE.md`: "11 migrations". There are 25 (`packages/db/migrations/0000–0024`).
- `13-admin-oidc.md` / `07-security.md`: OIDC is throttled, but it isn't (01.5).
- `08-observability.md:37` vs CLAUDE.md Testing ("UsageRecord per request, including failures"): they contradict each other (01.7).
- Per-slice lists are in each file's "Falsified doc claims".

## Done when
- Every high and medium is fixed with a failure-first test, or explicitly deferred with a reason in `status.yml` `notes`.
- The NN gates still hold: the host-tool rejection test is untouched and green, the log redactor test is green, and same-dialect passthrough is still byte-identical.
- `bin/check` green with `DATABASE_URL` (no skipped live-Postgres suites).
- `bin/bench` adds a ~280 KB-body scenario. After 01.1, the overhead p99 excludes upload and stays < 5 ms against `bench/baseline.json`.
- Prod re-check after release: `usage_records.router_overhead_ms` p99 < 5 ms, no `cost_basis = unknown` for `kimi`/`qwen3.8-max`, Alibaba cooldown carries `resets_at = 2026-10-13T16:00Z` (or the next stated reset).
- `docs/idea/` updated for every behavior change (06, 07, 08, 13 at least); `CLAUDE.md` migration count fixed.

## Risks / open questions
- Multi-replica findings (02.1 partial, 02.2, 02.10, 03.15) are tagged `[N>1]`. Prod runs 1 replica, so rank them below the single-replica highs unless the replica count changes.
- 04.7, 04.9, 04.14, 04.16, 04.17, 04.19, 03.16 depend on upstream behaviour that hasn't been observed. Capture a real body (redacted) before building.
- 01.14's fix (raising the idle timeout, or keeping non-stream connections alive) interacts with #125's heartbeat fix. Re-read that PR first.
- Open issues #137 (CLI refresh-lock collision) and #138 (price-table follow-ups) overlap 03.x / 02.7. Link them, don't duplicate.

## Not covered
- `config/env.ts` fully read only for defaults vs `09-deployment.md`. `packages/core` error map spot-checked.
- No live run of `bin/dev` / `bin/bench` this pass. Overhead diagnosis is from prod data + an in-process probe.
- Only ~8 h of prod log, with no Claude-sub traffic in it. GlitchTip events weren't pulled.
- Web: no browser run (`mcp__ui-debugger`). Findings are code-read + probe.
- Each slice's own "Not covered" section.
