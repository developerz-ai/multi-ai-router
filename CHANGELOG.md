# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.37.6] — 2026-10-15

### Documentation

- `MiniMax-M3.1-Flash-Preview` stays deliberately unpriced (#254). The vendor's public price list (platform.minimax.io/docs/guides/pricing, read 2026-10-15) carries no row for the preview — MiniMax serves it from the coding plan, and the per-token figures that circulate for it are resellers' and aggregators', not the vendor's price. `services/cost/tables/minimax.ts` now pins this in `MINIMAX_UNPRICED`, a registry of deliberately unpriced models whose entries must keep looking up null (asserted in `test/unit/cost/account-prices.test.ts`), so the documentation cannot drift from the table: its tokens keep recording `costBasis = unknown` and roll up as unpriced until an operator override prices it.

## [2.37.5] — 2026-10-15

### Added

- `glm-5.3` joins the shipped `zai` price table (#253). The #217 model census found it served on the production router with no price, so its tokens recorded `cost_basis = unknown`. Rates are z.ai's own published list (docs.z.ai/guides/overview/pricing, read 2026-10-15): input $1.4, output $4.4, cached input $0.26 per Mtok, no cache-write price published. A coding-plan account reports the row as a `notional` attribution, as with every zai model.

### Changed

- The `glm-5.3-flash` row keeps its numbers and moves its citation from OpenRouter's reseller list to the vendor's own pricing page, which now lists the model at the same figures.

## [2.37.4] — 2026-10-15

### Fixed

- A forced tool a third-party vendor answered in text is now returned as the tool call. MiniMax treats `tool_choice` as a hint even with thinking disabled: given a forced tool it answers `end_turn` with a text block holding the JSON and no `tool_use` (live matrix, 2026-10-15), so developerz.ai's structured-output probe (`generateObject`: tool `json`, `tool_choice any`) still failed with "no content parts". For an Account whose driver declares `thinkingOnByDefault`, when the upstream body forces a tool (`tool_choice` `tool` naming X, or `any` with exactly one tool) and the answer has no `tool_use` block, the text, trimmed and optionally inside one json fence, is parsed; if it is a JSON object it becomes that tool's `tool_use` block (`toolu_` id, `stop_reason: tool_use`, other text dropped, usage kept). The object is not validated against the schema. Prose, arrays, truncated answers (`max_tokens`), `any` over several tools and Anthropic accounts pass through unchanged. A forced request to these vendors is buffered whole, a stream included, and re-emitted as a valid SSE sequence; this costs only their forced calls' time-to-first-token. It applies on `/v1/messages` and on the openai-chat translation, so `tool_choice: "required"` and `response_format` (the `router_structured_output` tool) get it too. Each coercion logs one `forced_tool_coerced` line (account, provider, streamed; no content).

## [2.37.3] — 2026-10-15

### Fixed

- A forced `tool_choice` (`any` or `tool`) on an anthropic request relayed to a vendor that thinks by default (MiniMax, Z.ai, Kimi, `anthropic-compatible`) now states `thinking: {type: "disabled"}` when the client stated no `thinking`. MiniMax ignores the force while thinking, so `@ai-sdk/anthropic` `generateObject` (developerz.ai's structured-output probe: tool `json`, `tool_choice {type: "any", disable_parallel_tool_use: true}`, no `thinking`) got `end_turn` prose and failed with "no content parts". An explicit `thinking` of `enabled` or `adaptive` beside a forced tool is refused 400 in Anthropic's error shape (`invalid_request_error`, "thinking may not be enabled when tool_choice forces tool use"), as Anthropic itself does, instead of being sent to a vendor that would ignore the force. Real Anthropic accounts are untouched and still relayed byte for byte, as is any body without a forced choice. This is the second passthrough body edit after the model name; it parses a body only when it contains `tool_choice` and the account's driver declares `thinkingOnByDefault`.
- An anthropic completion that carries a tool call now reads `finish_reason: "tool_calls"` on openai-chat (non-streaming and streaming) when the vendor wrote `end_turn` beside the call, as MiniMax does under a forced tool. It read `stop`, which an OpenAI client takes as the end of a plain answer.

## [2.37.2] — 2026-10-15

### Fixed

- openai-chat `response_format` (`json_schema`, `json_object`) on an anthropic-dialect account is carried instead of refused `400`. It travels as the standard forced-tool technique: one synthesized tool (`router_structured_output`) whose `input_schema` is the caller's schema, forced with `tool_choice {type: "tool"}` and thinking disabled. The tool's input comes back as `message.content` (a JSON string) with `finish_reason: "stop"` and no `tool_calls`, non-streaming and streaming (as `delta.content`). `response_format` beside the caller's own `tools` is refused `400` naming `tools`, a non-object schema root is refused naming the field, and a client tool named `router_structured_output` is refused as reserved. Caught on MiniMax-M3.
- A forced `tool_choice` (`"required"` or a named function) on an openai-chat to anthropic hop now states `thinking: {type: "disabled"}`. The `any` / `tool` choice was already sent, but a forced tool and extended thinking cannot share a request on this dialect, and MiniMax's endpoint ignored the force while thinking was on and answered in prose with `finish_reason: "stop"`, so the constraint was lost at the upstream rather than in translation.

### Changed

- `assertPlainResponseFormat` is removed: no hop refuses openai-chat `response_format` wholesale any more. `docs/idea/06-protocol-translation.md` rows updated.

## [2.37.1] — 2026-10-15

### Added

- Tests pinning that `POST /v1/messages?beta=true` and `POST /v1/messages/count_tokens?beta=true` — the query Claude Code sends — route, relay and account exactly like the bare paths (#214). Covered on a passthrough (Anthropic API-key) account against a mocked upstream and on a subscription account stubbed at the `SdkInvoker` boundary; the suite fails if routing ever matches the full URL instead of the path. No runtime change.
- An optional `bin/smoke` leg `messages.claude_code_turn` (#214). It replays the redacted Claude Code 2.1.299 main-turn capture (`apps/api/test/fixtures/claude-code/`) as a streamed request carrying an `x-claude-code-session-id` header, and passes on a well-formed SSE answer (`message_start`, at least one content block, `message_stop`). Optional, so it never decides the exit code. A test enforces the capture's public-safe shape: `metadata.user_id` is `"<user_id>"`, every system and user text is a placeholder, and the bytes carry no `@`, no non-loopback IP, no credential shape and no home path.

### Documentation

- `docs/idea/11-anthropic-agent-sdk.md` notes that Claude Code posts with `?beta=true` and that the route is tested.

## [2.37.0] — 2026-10-15

### Added

- Input tokens and Output tokens tiles on the Usage page. Input counts every prompt token the upstream read (uncached, cache reads and cache writes, which the router stores apart) and its note gives the cache-read count and hit rate; output includes reasoning tokens. The Notional spend note now says it is the subscription traffic priced at list rates.

### Fixed

- The Overview's "Get your first working key" panel no longer stays up forever on a deployment that never created a pool. `onboardingComplete` needs an account and a key; a key scoped straight to accounts is a working deployment, so a pool is no longer required for the walk to count as done.

## [2.36.0] — 2026-10-15

### Added

- Usage page filters (#228). Owner, Tool and Model multi-selects narrow every figure, breakdown and the Export CSV link. Options come from the unfiltered summary for the page's window (owners deduped by slug, a selected value missing from the capped table still shown and removable). The window, a custom range and the filters live in the URL as `window` or `from` and `to`, plus `owner`, `tool` and `model` repeated once per value; a deep link restores the view and a window the server would refuse falls back to 7 days. The client sends repeated params, never comma-joined ones.
- Owner and Tool in the Usage page's "Break down by" switch and leaderboards. An owner row shows its kind (`person`, `service`, or `unknown` for a key that names none) so a person and a service sharing a slug are two rows; `unassigned` renders under its own label, and a key that survives only as a tombstone carries a `retired` marker.
- An Unpriced attempts tile (a dash when the window predates measurement, never 0) and a read-only weekly reports list on the Usage page, showing each stored week with its delivery status (`pending`, `not_configured`, `sent`, `failed`). A failure's error text is not shown.

### Changed

- The unfiltered usage summary keeps its cache key `["usage", "summary", <window>]`, so the keys and accounts tables still hit the Usage page's cache; filters append a sorted segment only when one is set.
- `UsageRoute` is split (headline tiles, custom range, filters, reports list and URL state are components), `usage.ts` sheds its window types to `usage-window.ts`, and the ui-geometry fixture splits into `fixture.ts`, `fixture-usage.ts` and `fixture-time.ts` and carries the new required `byOwner`, `byTool` and `retired` fields. No API behaviour changes.

### Documentation

- `docs/idea/08-observability.md` ("Where the numbers appear", new "The Usage page") and `docs/KEYS.md` ("Where your usage shows") describe the page. The null-pool gloss in the web client's usage header now matches the documented meaning.

## [2.35.0] — 2026-10-15

### Added

- Weekly usage report (#227), generated and stored in-process. The `usage_weekly_report` scheduled task makes one report per UTC Monday-to-Monday week, once its anchor has passed (the latest Monday 00:00 UTC plus `USAGE_REPORT_WEEKDAY`, `USAGE_REPORT_HOUR_UTC` and `USAGE_REPORT_SETTLE_MINUTES`) and the last complete week has no row; three missed weeks make one late report for the latest week. It is stored in the new `usage_reports` table (migration 0037, unique `period_start`, inserted `ON CONFLICT DO NOTHING`, `delivery_status` text typed against a core union and starting `pending`); delivery is a later change. The payload has people, services and unknown-kind sections by owner x tool, the `unassigned`, `deleted` and `none` buckets, totals, top models, the overflow share per (service key, pool with an overflow account) with the key name, pool name and overflow provider, and caveats. METERED and NOTIONAL are separate fields, summed exactly, and an unmeasured unpriced count is `null`, not 0. It never carries an account label.
- `GET /api/admin/usage/reports`, `GET /api/admin/usage/reports/:periodStart` (`400` for a malformed or non-Monday date, `404` when absent) and `POST /api/admin/usage/reports/preview` (builds the last complete week, stores nothing; needs the CSRF token like every admin `POST`).
- `USAGE_REPORT_INTERVAL_MINUTES`, `USAGE_REPORT_WEEKDAY`, `USAGE_REPORT_HOUR_UTC`, `USAGE_REPORT_SETTLE_MINUTES`, `USAGE_REPORT_MAX_ROWS` and `RETENTION_USAGE_REPORTS_DAYS` (default 730). Boot refuses `RETENTION_USAGE_REPORTS_DAYS` below 14, by name: the task regenerates a missing last-complete week, so a row swept while its week is still the target would be generated again. Boot also refuses a schedule whose remaining firing window (the time from the anchor to the end of the week) is not longer than one slowest jittered tick plus a 5 minute margin, which could skip a week while the task reported success; `USAGE_REPORT_INTERVAL_MINUTES` is capped at a day. `USAGE_REPORT_MAX_ROWS` (default 50000) bounds the week read: over it the task fails, and the preview answers `400 report_too_large`, naming the variable, never a truncated report. The report's coverage states the real gap between the week's end and generation, the unpriced share is divided by attempts on measured days, and every line carries cache read and write tokens. The janitor sweeps `usage_reports` on the `period_start` instant, strictly.

### Changed

- The `scheduled_task` enum gains `usage_weekly_report` (one-way; an older image reading a run row under the new name is covered by the removed-task rollback test).
- `historySource` gains a named week read beside it (`readUsageWeekRows`, key x account x pool x model, no day dimension). The scheduler's re-export tail moves from `tasks/index.ts` to `tasks/exports.ts` to keep the registry under the file cap.

### Documentation

- `docs/idea/05-routing-and-failover.md` no longer claims overflow-served requests are marked in `UsageRecord` (there is no such marker) and says how the question is answered now: the report's overflow share, read against the pool's designation at generation time. Weekly report spec in `01`, `08` and `09`.

## [2.34.0] — 2026-10-15

### Added

- `GET /api/admin/usage` returns `byOwner` and `byTool` (#246). Rows are folded in SQL, before the breakdown row cap, from the key labels the service already loads (live keys plus tombstones), passed as one `unnest(uuid[], text[], text[], text[])` relation so a large key set costs four binds. The history, raw latency and per-row series queries share one bucket expression, so their group keys match. `byOwner` ids are `<ownerKind>/<owner>` with an `ownerKind` field (a person and a service sharing a slug are two rows; an owner with no kind uses the segment `unknown` and `ownerKind: null`); `byTool` ids are the tool slug. Three non-owner buckets are their own rows with `id: null`, `label: null` and a `note` of `unassigned` (key present, no owner or tool), `deleted` (key id with neither a live row nor a tombstone) or `none` (no key); the SQL tells them apart by sentinels outside the slug grammar, so their latency and series cannot collapse. `byKey` rows gain a boolean `retired`, true only for a key that survives solely as a tombstone. `coverage.breakdown.truncated` names `owner` and `tool` when capped. Owner and tool attribution follows each key's current label. `UsageDimension` gains `owner` and `tool`; the history and raw `breakdown` and `seriesByDimension` are overloaded so `owner` and `tool` require a key-attribution argument (an absent one throws), and `UsageDailyRepository.breakdown` is narrowed to the four column dimensions. `KeyLabel` gains `retired`. The `/recent` feed is unchanged.

### Documentation

- The `usage_records.pool_id` gloss now says it is null whenever no pool was in play, including an attempt that failed before an account was selected on a pool-scoped key, in the schema comment, the observability spec, the recent-feed and web wire-type comments and the repository types.

### Changed

- The Usage page's truncated-breakdown notice names Owner and Tool instead of "Other groups".

## [2.33.0] — 2026-10-15

### Added

- `GET /api/admin/usage/export.csv` (#226): the usage the summary shows, as a CSV attachment, with the same window and the same six filters. One row per UTC day x key x account x pool x model, read from the same sources and predicate as the summary totals, so each column sums to the summary. Header `day, owner, owner_kind, tool, key_name, key_prefix, pool, account, provider, model, requests, attempts, errors, tokens_in, tokens_out, cache_read, cache_write, cost_metered_usd, cost_notional_usd, unpriced_attempts`. Absent labels are empty cells; `unpriced_attempts` is empty before the measure started. Every text cell is guarded against spreadsheet formulas (a leading `=`, `+`, `-`, `@` or tab, their full-width forms, or the same lead after `;`, tab or `,`, gets a leading `'`; CR, LF, VT, FF, U+001C-U+001E, NEL, U+2028 and U+2029 inside a text cell become a space), because any router-key holder chooses the `model` string. No key value or ciphertext is ever written; `key_prefix` is the public display prefix. `USAGE_EXPORT_MAX_ROWS` (default 50000, 1..100000) is decided before the first byte: over it answers 400 naming the cap; the body then streams in chunks of at most 1000 rows or about 32K characters, yielding to the event loop between them, instead of one synchronous render. The file carries no ids and no coverage signal (stated in `docs/idea/08-observability.md`). The Usage page gains an **Export CSV** link built from the params the summary sends.

### Changed

- `KeyLabel` carries the key's display `prefix` (live row or tombstone). The window resolution shared by the summary and the export moves to `read-window.ts`.

## [2.32.0] — 2026-10-15

### Added

- `GET /api/admin/usage` filters by owner, tool, model, key, pool and account (#225). Each is a repeated query param (`?owner=a&owner=b`, never comma-split); values within one dimension are OR-ed and dimensions are AND-ed. `owner` and `tool` match a key's stored slug exactly, resolved to key ids from the live keys plus tombstones, so a purged key still counts; an owner or tool that matches no key returns zeros, never the unfiltered totals. `keyId`, `poolId` and `accountId` must be uuids (a malformed one is a 400). The predicate is applied inside every history source (legacy `usage_daily`, both v2 rollups, receipt contributions) and inside the raw latency, outcome and breakdown panes, so totals, series, breakdowns and `failures` agree; metered and notional stay separate and `unpriced` is filtered like every other measure. `coverage` stays unfiltered, which can only over-report `incomplete`. `filter` is a required argument on the history and raw usage repositories (`{}` = no filter), so a read that forgets to forward it fails to compile. Ids are lowercased; values are non-empty, NUL-free and at most 500 per filter. The usage label loader now reads live keys before tombstones, sequentially. `usage-filter.ts` (the array-bound predicate) is new. Before this, the params were silently dropped and a filter returned unfiltered totals. The `/recent` feed and the breakdown rows' own shape are unchanged.

### Changed

- `GET /api/admin/usage` now answers `400`, naming the key, for any query parameter outside `window`, `from`, `to` and the six filters. It was ignored before, which let a misspelled filter return unfiltered totals.
- `usage-read-repository.ts` and `usage-read-types.ts` are split by responsibility (`usage-tokens-since.ts`, `usage-token-spans.ts`); exports are unchanged.

## [2.31.0] — 2026-10-15

### Added

- A purged or deleted key keeps its attribution (#224). Migration `0036_key_tombstones` adds `api_key_tombstones` (`id, name, prefix, owner, owner_kind, tool, purged_at`; no value or ciphertext column). The janitor's revoked-key purge deletes the key and writes its tombstone in one statement, and `DELETE /api/admin/keys/:id` does the same in one statement, both stamped from the injected clock. The usage label loader names a key by its live row, else its tombstone, so `byKey` and the recent-attempts key subject keep the name (and the loader carries owner, owner kind and tool) instead of showing "deleted". The janitor sweeps tombstones at `RETENTION_USAGE_DAILY_DAYS` plus one day, since rollups age by whole UTC day and the tombstone must outlive the rollups it labels. Verification, reveal and the admin key list never read tombstones; the `GET /api/admin/usage` wire shape is unchanged. Keys purged before this release have no tombstone and stay "deleted"; there is no backfill.

## [2.30.1] — 2026-10-15

### Documentation

- `docs/KEYS.md`: the router-key runbook for operators and requesters (mint with owner, kind, tool and purpose; scope to a pool; client setup; planned rotation through Mint successor under a new name; a separate leaked-or-lost path that revokes first; revoke, including the per-replica `KEY_CACHE_TTL_SECONDS` bound and the `RETENTION_REVOKED_KEYS_DAYS` attribution window; hand back is revoke, never delete), the key, scope and capacity errors a key holder sees, and where per-key usage shows today. Linked from `README.md` and `docs/idea/04-api-keys-and-access.md`, whose revocation row now states the per-replica bound, as do the two revocation lines in `docs/idea/02-domain-model.md`. The per-key spend budgets row in `docs/idea/10-roadmap.md` gains its current-state reason. A test (`apps/api/test/integration/keys-runbook-docs.test.ts`) holds the file and both links in place, and checks every status/code pair in the runbook's error table against the error classes. Refs #230.

## [2.30.0] — 2026-10-15

### Added

- Unpriced traffic is counted instead of reading as $0 (#220). The attempt rollup gains `unpriced_attempts` (attempts with unknown cost that used tokens; NULL = not measured, never back-filled). The usage API reports `unpriced: { attempts, since }` on totals and breakdown rows, across the daily tables and the receipts query that answers `today`. Migration `0035_unpriced_attempts` adds the columns and records `unpriced_since` as the day after it runs; a window wholly before that date reads `attempts: null`, never 0. This differs on purpose from `router_cost_basis_total`, which also counts token-less failed attempts. Rolling back past 2.30.0 and upgrading again requires moving `usage_history_state.unpriced_since` forward past the last day the old image wrote, or those days read as measured.

## [2.29.0] — 2026-10-15

### Added

- `bin/ui-geometry`: a layout gate that drives pinned headless Chromium (Playwright, DejaVu fonts, deviceScaleFactor 1) against the built SPA, with the admin API answered by in-process route mocks (no router, database or provider involved), and fails the build when cost text or a cost block paints outside its cell or through a credential badge (`/accounts`) or into a neighbouring cell (`/keys`) at 1024, 1280 and 1440px (#223). It measures painted ink (a Range over the contents), not element boxes, so text overflowing a too-narrow flex item is caught; it also holds the badge background opaque and fails on any empty selector scope, the gap that let #94 undo the #62 fix with CI green. It runs as a CI job and has pure rule tests in `apps/web/test/unit/ui-geometry-rules.test.ts`.

### Documentation

- Corrected stale cost-column passages: the accounts table folds metered and notional spend into the usage cell (TrafficCell), and only the keys table has a Cost column of its own.

## [2.28.1] — 2026-10-15

### Fixed

- **A Codex spent balance is `credits-exhausted`, in a stream and over HTTP.** `insufficient_quota`, `credit_balance_exhausted`, `organization_spend_limit_exceeded` and `project_spend_limit_exceeded` (the four codes the Codex CLI maps to a fatal `QuotaExceeded`, openai/codex `codex-rs/codex-api/src/sse/responses_error.rs` at `f82e3659`) classified `codex:stream-error:other` in a stream and `rate-limited` on a `429`, so a spent account cooled down and was retried on a timer. A new `CODEX_QUOTA_CODES` list (`apps/api/src/providers/drivers/openai-oauth-stream-errors.ts`) feeds the stream hook (only from `response.error.code` of a frame whose own JSON `type` is `response.failed`, the one place the CLI reads them, and there even beside a root `code` or `error`; a type-only frame, a root `code` or `error`, a bare `error` event, or a frame typed only by its SSE event name is retried or skipped there, so each stays `server-error`) and two new HTTP rules in `openai-oauth.ts` that apply only on a `429`, as the CLI reads them (the CLI reads the `error` envelope only; the driver also reads the `detail` envelope it reads every Codex code from) (signal `openai-oauth:insufficient_quota`; the CLI's fifth 429 code, `organization_usage_limit_exceeded`, is left as `rate-limited`, since its name says a usage window). The account goes `exhausted`. The CLI never retrying these does not by itself make them permanent (it does not retry a usage limit either); their meaning does, a balance or a spend cap, as on OpenAI's API. No production frame was captured; the test frame is the shape the CLI's own test uses.
- **An oversized MiniMax in-body failure is no longer read as success.** A MiniMax body over the observation cap went through the salvage scanner, which kept no `base_resp`, so the driver hook saw no envelope and a `1008` (spent balance) on a 200 settled as a success. `base_resp.status_code` is now a salvage slot with its own 32-byte ceiling (`apps/api/src/services/usage/response-salvage-slots.ts`; the scanner is `response-salvage.ts`); the free-text `status_msg` is never kept, so a long one cannot push the code out, and a code over 32 bytes, or one that would cross a full budget, drops itself without evicting other evidence, is released first, before the optional `error` and `code`, when a required member needs room, and is lent to error evidence that needs the room and given back if that evidence drops anyway, rather than failing the salvage; a repeated `base_resp` (or `status_code`) replaces the earlier one, so the last wins, as in `JSON.parse` (for byte-identical keys; escaped keys are #209); a malformed code is dropped, never failing the salvage, and when the frame shows one of two structural violations at depths 1-2 (a second value under one key, or a non-string value where a key or its colon belongs, as in `"status_code":0 1008` or `"base_resp":{...} {"status_code":1008}`), no code is kept from that frame, including one kept earlier. The scanner is not a JSON validator: other malformed frames (for example stray or doubled commas or colons, a wrong closer, errors inside arrays or deeper, bad literals; the full list is on #209) can still yield the code they contain; accepted; losing it reads as before the slot existed. Also fixed in the same scanner: a root key named like an `Object` built-in (`constructor`, `toString`) holding an object threw a `TypeError`; slot lookup now reads own keys only.
- **The attempt-failure log line redacts before it cuts.** `upstream attempt failed` cut the upstream message to `LOG_REASON_MAX_CHARS` and left redaction to the logger, so a credential across the cut could survive as a fragment. The HTTP path redacts earlier; the Agent-SDK path does not. Both log lines now share one redact-then-cut helper (`apps/api/src/services/dataplane/attempt-log.ts`). This also closes the same gap in 2.25.8's `upstream stream failure` line, whose 4,096-character window could keep a fragment once a long credential before it collapsed to `[REDACTED]`; that window is gone. Up to 64 KiB (the upstream error-body cap) the whole message is redacted before the cut, so every credential is matched with its own terminator and the words before a collapsed token are still logged. Past 64 KiB (an Agent-SDK message is not bounded by the upstream caps) the scan ends at the last whitespace before the 64 KiB mark; no credential's secret part spans whitespace (a `Bearer`/`Basic` gap comes before its token), so none can straddle the cut. A message with no whitespace at all in its first 64 KiB is one token nothing can safely be cut from, so only `…` is logged. A cut never splits a `[REDACTED]` marker, and the quote is re-redacted and pulled back until it fits, so the logger's own pass cannot push it past `LOG_REASON_MAX_CHARS`.
- **A userinfo password holding an unencoded `/` is scrubbed** (`postgres://u:p/ss@h`), in the server redactor (`apps/api/src/logging/redact.ts`) and the boot-path scrub (`packages/core/src/scrub-credentials.ts`). It is a new first branch beside the unchanged original pattern, so it only adds matches. It is bounded to 256 characters and stops at `:`, so redaction stays linear and cheap; neither its username nor its password crosses `?`, `#`, `&`, `=` or `"`, so it can never swallow the `password=` key of a query-string secret holding an `@` (`postgresql://db:5432/app?password=p@ss`), which the query-string pattern then redacts as before, nor run across a JSON field. A slash password holding one of those characters is not caught, as before, except base64 `=` padding just before the `@`. In the boot-path scrub the padding is not allowed right after a key name of its key=value pattern (`jdbc:postgresql://h:5432/db;password=@S` stays that pattern's), since that pattern anchors on a word boundary rather than `?` or `&`. Price: a URL with a port and an `@` later in its path (`https://host:8080/a@b`) loses its host.
- **The boot-path credential scrub is linear.** `scrubCredentials` carried the two quadratic shapes 2.25.8 removed from the server redactor; on this host the old code took 12.7 s on the new cost case's inputs (64 KB of `a-`, 64 KB of `eyJ-`, 72 KB of `eyJaaaaa-`, and the `://` runs), and over a minute on the first alone under heavy load. The scheme now stays outside the userinfo match (a linear lookbehind still requires the real scheme `main` required, so `x_y://a:password=@S` stays the key=value pattern's), and the JWT header is bounded with a lookbehind-anchored long-header pattern beside it. Timing cases in `packages/core/test/unit/scrub-credentials.test.ts`. Price, as on the server: a JWT whose header is over 512 characters and is glued straight after `-`, `_` or a letter is no longer scrubbed by this boot-path backstop.
- Not changed: the original userinfo branch can still match across a JSON field boundary (`"url":"http://h:1","note":"x@y"`). That only mangles log text and leaks nothing; excluding `"` from it would let a password containing `"` through, and a scrubbed line costs less than a leaked one.
- Tests: `test/unit/dataplane/attempt-log.test.ts` (new), `test/unit/redact.test.ts`, `packages/core/test/unit/scrub-credentials.test.ts`, `test/unit/providers/openai-oauth-stream-errors.test.ts`, `test/unit/providers/openai-oauth.test.ts`, `test/unit/services/usage/response-observer-codex.test.ts`, `test/unit/usage/response-salvage.test.ts`. Refs #206.

### Documentation

- `docs/idea/03-providers.md`: an `openai-oauth` row in the credits-exhausted signal table. `docs/idea/05-routing-and-failover.md`: the quota codes and the `base_resp` salvage slot in the in-stream row. `docs/idea/07-security.md`: slash passwords in the value-shape list. `docs/idea/08-observability.md`: `upstream attempt failed` scrubs before it cuts. `docs/idea/09-deployment.md`: the salvage members and the lent 32 bytes in `UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES`.

## [2.28.0] — 2026-10-14

### Added

- **Structured output is carried from openai-chat onto openai-responses.** `/v1/chat/completions` with `response_format` against a Responses account (ChatGPT/Codex `openai-oauth`, or `openai-api` on Responses) was refused `400 translation_failed` ("this build translates no structured-output constraint onto another dialect"; production, 2026-10-14, `gpt-6-luna`), although the Codex backend honours `text.format`. It is now translated (`shared/structured-output.ts`): `{type: "text"}` / absent → no constraint; `{type: "json_object"}` → `text.format: {type: "json_object"}`; `{type: "json_schema", json_schema: {name, schema, strict?, description?}}` → `text.format: {type: "json_schema", name, schema, strict?, description?}`, every value verbatim. `name` is validated as OpenAI does (`^[a-zA-Z0-9_-]{1,64}$`) and defaults to `"response"` when omitted, since Responses requires one. A malformed `response_format` (no `json_schema` object, a bad name, no `schema`, a non-boolean `strict`, a non-string `description`, an unknown `type`) is still a `400` naming the field, never the value. Every other crossing (openai-chat → anthropic, openai-responses → openai-chat / anthropic) still refuses structured output, and `stop` is still refused toward Responses, which has no stop parameter.
- `glm-5.3-flash` is priced in the `zai` table at OpenRouter's list (read 2026-10-14): input 0.15, output 0.50, cached read 0.03 USD per Mtok. Before this it priced as unknown. `gpt-6-luna` already had a row (OpenAI card, 0.10 / 0.50 / 0.01), so that row is unchanged.

### Changed

- A Responses `refusal` part reaches an openai-chat client in Chat's own refusal field: `message.refusal` collected, `delta.refusal` streamed. Before this it was joined onto `content`, which a structured-output caller would then fail to `JSON.parse`. A refusal-only answer is `content: null` plus `refusal`, with `finish_reason: "stop"`. Anthropic clients still get the refusal as text.

## [2.27.0] — 2026-10-14

### Added

- `ADMIN_OIDC_REQUIRED_CLAIMS`: claim-based admin OIDC admission, IdP-agnostic. Comma-separated `name=value` pairs (e.g. `kind=dev_user`), every one of which the **verified** ID token must satisfy: a string claim exactly equal to the value, or an array claim containing it (case-sensitive). A missing claim, or one of any other shape, is rejected. The OIDC block now needs `ADMIN_OIDC_ADMIN_EMAIL`, `ADMIN_OIDC_REQUIRED_CLAIMS`, or both; neither is a boot error naming both, and a malformed pair (`kind`, `=x`, `kind=`) fails boot. With both set, both must pass, so adding claims to an email-allowlist deployment only narrows it. Email-only configurations behave exactly as before. `email_verified: true` is still required, a claim rejection is a `principal` failure with the same log line and `admin.login_failed` audit row as an email mismatch (naming the claim, never the token's value), and it is still one admin principal. Setting it alone trusts the IdP's own user gating; see `docs/idea/13-admin-oidc.md`.

### Changed

- ID-token claims beyond the standard ones are now kept on the verified payload instead of being stripped at parse time, so the claim gate reads the signed token, not a second decode.

## [2.26.1] — 2026-10-14

### Fixed

- A pool-scoped key's pools are tried in the order they were listed, as the spec promises (#221). The order was never stored: the scope table had no position and its reads had no `ORDER BY`, so an index scan could return pools by id and silently swap a primary pool with its fallback. Migration `0034_pool_scope_position` adds `position` (default 0, so a previous release's insert still works) and backfills the order a sequential read returns today (on a large table read through the `(api_key_id, pool_id)` index, keys switch from pool-id order to the backfilled physical order). A key whose scope the previous release edited after the upgrade ties at position 0 and should be re-saved.

## [2.26.0] — 2026-10-14

### Added

- Router keys carry four optional attribution labels: `owner`, `ownerKind` (`person` | `service`), `tool` and `purpose` (#219). They are set on create, cleared with `null` on PATCH, and filterable with `GET /api/admin/keys?owner=<slug>&tool=<slug>`. The console form edits them, the Keys table shows `owner / tool` with filter chips, and a **Mint successor** action prefills a rotation (never the key value). An owner is a label for usage attribution, not a router user. Request authentication is unchanged. Migration `0033_key_attribution` adds nullable columns only, so existing keys keep working. A key `name` or `purpose` containing U+0000 is rejected with `400`.

### Changed

- `GET /api/admin/keys` validates its query strictly: an unknown parameter now answers 400 instead of being ignored (#219).

## [2.25.8] — 2026-10-12

### Fixed

- **An in-stream Codex error is classified from its code, so a request-shaped refusal no longer cools the account.** A `response.failed` event or a bare `error` event inside an HTTP 200 stream was read as a fixed `server-error`; three in a row cooled the account and the router answered its own `429` (production, 2026-10-11). The `openai-oauth` driver now installs `responseObservation.inspectPayload` (`apps/api/src/providers/drivers/openai-oauth-stream-errors.ts`), pure and stream-only (the HTTP `rules` are unchanged). It returns `null` for any frame whose type (`payload.type ?? event`, as the protocol reader reads it) is not `response.failed` or `error`. Otherwise the code decides (top level, then `error.code` / `response.error.code`); only when there is no code is the nested error object's `type` read, and only for the limit and deactivated codes (the HTTP rules' lists; unlike them, a code present always decides) (`invalid_request_error` is OpenAI's catch-all type, carried by account-level refusals too, so a type never marks a refusal request-shaped). The flat event's own `type` is never read. The closed list: `invalid_prompt`, `invalid_request_error`, `context_length_exceeded`, `unsupported_parameter`, `unsupported_value`, `invalid_json_schema` → `invalid-request` (outcome `client_error`, no breaker strike); `usage_limit_reached`, `rate_limit_exceeded` → `rate-limited` (the breaker trips on the first hit, with an estimated backoff); `account_deactivated` → `credits-exhausted` (`exhausted`); any other code, or no code → `server-error`, as before. The driver's HTTP rules import the same limit and deactivated lists.
- **A frame past the observation cap keeps its error.** Codex echoes instructions and tools into `response.failed`, so a large prompt pushed the frame through the salvage scanner, which dropped `response.error` and with it the code (`apps/api/src/services/usage/response-salvage.ts`). Root `error` and `code` and `response.error` are now kept when small; an error member over a quarter of the cap, or one that would cross the cap, is dropped, and a required member that needs the room evicts kept error members first, so error evidence can never fail the salvage: the frame still reads as a failure (`server-error`), never as success.
- **The usage row records which error it was.** `errorClass` is the driver hook's signal when a hook answered (`codex:stream-error:<listed code>` or `codex:stream-error:other`; MiniMax's existing in-body hook now records its closed `minimax:base_resp-<code|unknown>` there too), and `upstream_protocol_error` when none did. `relay-terminal.ts` accepts a hook signal only in the `<driver>:<rule>` shape, which bounds the `error_class` label's charset and length and turns an upstream sentence into the protocol default; cardinality rests on each hook building its signal from a closed list, as both do. Codex in-stream rows' `outcome` follows the classification (`client_error`, `quota_exhausted`, `credits_exhausted` or `upstream_error`) instead of always `upstream_error`.
- **The upstream's words are logged once, safely.** A new `upstream stream failure` warning (`logStreamFailure`, `apps/api/src/services/dataplane/attempt-log.ts`) names `accountId`, `errorClass` and `upstreamMessage`: the hook's reading of the message, redacted first (only the part that can be kept, plus 4,096 characters, so a credential straddling the cut, a ChatGPT access token included, is matched whole) and then cut to the operator's `LOG_REASON_MAX_CHARS`. It is written after the breaker update and the usage row, and the message never reaches a usage row.
- **Two log-redaction patterns no longer backtrack quadratically** (`apps/api/src/logging/redact.ts`). The URL-userinfo pattern no longer matches the scheme (it stays in the text), and the JWT pattern bounds its header segment to 512 characters, with a second, lookbehind-anchored pattern for longer headers (a DPoP proof's key, an x5c chain). A userinfo URL with an empty username (`redis://:password@host`) is now scrubbed too. Before, a long `a-a-a-…` run took about 3 s per 16 KB and an `eyJ-eyJ-…` run about 13 s per 64 KB on the event loop; 64 KB of each now takes at most about 0.1 s. A userinfo URL behind a scheme of any length is still scrubbed. This applies to every value redacted by `apps/api/src/logging/redact.ts` (logs and client-facing error bodies), not just the new line. A long-header JWT glued straight after `-`, `_` or a letter is not matched, the price of staying linear.
- Tests: `test/unit/providers/openai-oauth-stream-errors.test.ts` (the closed list, both wire shapes, nested `type`, frame-type precedence, the non-error early return), `test/unit/services/usage/response-observer-codex.test.ts` (observer facts, `errorClass` through `relay-terminal` for Codex, MiniMax and a hookless driver, the signal-shape guard), `test/unit/dataplane/codex-stream-warn.test.ts` (passthrough: three refusals in both shapes leave the account active, three unknown codes cool it, the bounded warn line) and `test/unit/dataplane/codex-stream-translated.test.ts` (the production shape, a translated non-streamed `/v1/messages`: three refusals, a frame past the cap, an error too large to keep, a credential across the cut).

### Documentation

- `docs/idea/05-routing-and-failover.md`: the in-stream refusal row (code then nested type, the salvage rule, what each class does to the account).
- `docs/idea/08-observability.md`: `errorClass` is a closed signal, never a message; the `upstream stream failure` line.

## [2.25.7] — 2026-10-11

### Fixed

- **Codex backend refuses tool-schema `pattern`s containing a regex lookaround.** A new `stripLookaroundPatterns` flag on `ResponsesEgressRules` (`apps/api/src/services/translate/shared/responses-egress.ts`) is `true` on `CODEX_RESPONSES_EGRESS` (`apps/api/src/providers/drivers/openai-oauth.ts`). On a translated request to that surface, `apps/api/src/services/translate/shared/schema-lookarounds.ts` removes every `pattern` containing a lookaround (`(?=`, `(?!`, `(?<=`, `(?<!`; a named group `(?<name>…)` is not one and is kept) from each tool's `parameters`, walking `items` (object and array form), `additionalItems`, `unevaluatedItems`, `prefixItems`, `additionalProperties`, `unevaluatedProperties`, `propertyNames`, `contains`, `contentSchema`, `not`, `if` / `then` / `else`, `anyOf` / `oneOf` / `allOf`, and the subschema values of `properties`, `patternProperties`, `$defs`, `definitions`, `dependentSchemas` and `dependencies` (its property-list arrays are kept as they are). Data keywords (`default`, `enum`, `examples`, `const`) are never entered; `patternProperties` regex keys are out of scope. Each removal is reported by tool name and schema path (a `patternProperties` entry by index), never by value, through the existing "translation dropped fields" warning. The walk never mutates its input (the parsed source is reused for later failover candidates), keeps a property named `__proto__`, returns the original object when nothing changed, skips the walk for a tool whose serialized schema holds no lookaround anywhere, and refuses a walked schema nested deeper than 64 levels, or walked schemas holding more than 10,000 subschemas across the whole request, with a `400`, so the walk's CPU per request is bounded. The flag is part of the conversion-cache key (`egressKey`, `apps/api/src/services/dataplane/translate-body.ts`). Same-dialect `/v1/responses` is relayed untouched (non-negotiable 10). Tests: `apps/api/test/unit/translate/schema-lookarounds.test.ts` (each lookaround form, named groups kept, every walked keyword with its reported path, data keywords kept, `__proto__`, the depth bound, the request-wide node bound, exact output with only the reported patterns removed, no mutation, report contents), `apps/api/test/unit/translate/responses-egress-rules.test.ts` (surface flags; the strip through the translators), `apps/api/test/unit/dataplane/translate-body.test.ts` (cache key), and `apps/api/test/integration/codex-translate.test.ts` (`/v1/messages` and `/v1/chat/completions` to a mocked Codex account send no lookaround upstream; a same-dialect `/v1/responses` body reaches the upstream byte-identical).

### Documentation

- **`docs/idea/06-protocol-translation.md`**: the "Surface rules" table gains `stripLookaroundPatterns`; the "Known lossy edges" table gains a row listing the walked keywords and what is out of scope; the "Tool and function calling" table names the strip under "Dropped and reported". **`docs/idea/03-providers.md`**: both `openai-oauth` rows (the summary row and "Translated bodies") name the strip. Refs #187.

## [2.25.6] — 2026-10-11

### Fixed

- **`bin/smoke`: a malformed reply on an informational leg is proven not to gate the run.** A new integration test drives all eight legs with well-formed `/v1/messages` replies and malformed `/v1/chat/completions` (`choices: [null]`) and `/v1/responses` (`output: [null]`) replies: the run resolves, both informational legs are FAIL `malformed-body`, and the exit code is `0`. It goes red if the chat grader's null-element guard is removed. `gradeResponses` now rejects the whole body when any `output` element is not a `{type}` object (it used to skip bad elements, so `[null, {type:"function_call"}]` passed). The `legs.ts` header names `run.ts` as the reader of the legs.
- **Tool-call tests that can fail.** The `openai-oauth` forced-tool test now sends `temperature` and `top_p`, so its "absent upstream" assertions fail if `CODEX_RESPONSES_EGRESS` stops stripping them. The reasoning-shape cases again assert the usage row's `outcome` and `costBasis` (2.25.5 had relaxed them to a row count) and now check the client body (`stop_reason`, and the `tool_use` id `call_1`). The chat-completions stream case asserts the tool name and id, and both chat cases pin whether a stream was sent upstream. The `openai-oauth` forced and `any` stream cases assert the upstream `tools` and `tool_choice` and the client `tool_use` id.

### Documentation

- **`docs/idea/06-protocol-translation.md` and `docs/idea/03-providers.md` separate the two edges.** `temperature` / `top_p` are forwarded on `openai-api` and rejected by the upstream when reasoning is on; the Codex path strips them (with `max_output_tokens`) from every translated request, reasoning on or off. `text.format` / `response_format` other than plain text is refused on every cross-dialect hop (a same-dialect body is relayed untouched), so a call that will be translated must carry it as a forced tool call. The GPT-6 row now says how `openAiEffortFromAnthropic` produces a level (a client's explicit effort passes through; an `enabled` budget is bucketed; `adaptive` and `disabled` produce no level). `docs/idea/08-observability.md`: the GPT-6 long card applies once the prompt including cache tokens reaches 272,000.
- **Release notes for 2.24.0 to 2.25.5 corrected.** 2.25.5 no longer lists a fix that did not ship, no longer presents the pre-existing `openai-api` sampling assertions as new, and no longer claims the router never emits a `reasoning_effort` value. 2.25.4 no longer claims the casts in `grade.ts` are gone. 2.25.2's documentation line and 2.25.1's subprocess and malformed-body lines say what shipped; 2.25.4's "total graders" claim is scoped; 2.25.3's long-card threshold counts cache tokens. 2.25.0 no longer names a file added in 2.25.4, and restores its `docs/clients.md` pointer. 2.24.0 no longer duplicates the 2.25.0 entry, and the duplicate 2.25.3 heading is removed.

Refs #183, #194, #196, #198, #199.

## [2.25.5] — 2026-10-11

### Fixed

- **Test coverage and claims for the tool-call integration tests (`apps/api/test/integration/openai-tools.test.ts`).** The four primary cases — forced tool, `tool_choice: any`, tool-result follow-up, parallel function calls — now each carry a non-stream and a stream variant on the `openai-oauth` path (the tool-result and parallel cases were non-stream only at 2.25.2). Each case now runs in both reasoning shapes (absent and `thinking: {type: "adaptive"}` plus `output_config: {effort: "low"}`) instead of only the forced case. Fixtures now use a distinct item id (`fc_*`) and call id (`call_*`), so a translator that mints the client `tool_use.id` off the item id rather than the `call_id` is detected. The streamed tool_use frame is parsed to assert the `tool_use.id` is `call_*` and that the `input_json_delta` frames accumulate into the arguments. The parallel stream case asserts two `content_block_start` blocks with distinct ids and per-block `input_json_delta`. The `/v1/chat/completions` case into a Responses-speaking account mocks a JSON Responses reply (was SSE) and asserts `content-type: application/json`, `choices[0].message.tool_calls[0]` with `id = call_*`, and `finish_reason: "tool_calls"`. The forced-tool test on `openai-api` already sent `temperature` and `top_p` and asserted they reach upstream (unchanged). The `openai-oauth` any-stream test asserts a `content_block_start` of type `tool_use` (substring checks; the `openai-api` stream cases likewise). The tool-result follow-up drops its forced `tool_choice` and asserts that the upstream `input` carries `function_call` (with `call_id`, `name`, `arguments`) before the `function_call_output`. Every test asserts exactly one `usage.rows` row. The header and a chat-completions comment that asserted "the openai-responses dialect always streams" and "SSE regardless" are corrected to the actual split (`openai-oauth` forces a stream; `openai-api` does not). The forced-tool OAuth test was recording its assertions as if the request body sent `temperature` / `top_p`; the request body never sent them, so the assertions could not fail — the assertions stay and pin the no-injection rule, while the openai-api test exercises the actual field path.

- **Mutation probe recorded.** Changing `toolChoiceToOpenAiResponses` (`apps/api/src/services/translate/shared/tools.ts`) to return `"auto"` for an object choice makes the three forced-tool tests that assert `tool_choice` fail; the mutation was reverted. No source file changed in this version.

### Documentation

- **`docs/idea/06-protocol-translation.md`.** The "Tool calls against GPT-6" row dropped the false parenthetical "(the only shapes Anthropic sends here)" and its unclosed bold. The `temperature` / `top_p` row was rewritten but still tied the structured-output rule to the sampling-field rule; 2.25.6 separates them.

- **`docs/idea/03-providers.md` points the `openai-api` and `openai-oauth` rows at the two edges.** Both rows now state that `temperature` / `top_p` are rejected on reasoning-on Responses (Codex drops at the egress; `openai-api` forwards verbatim and lets the upstream refuse), and that `response_format: json_schema` is refused across dialects, so a structured call must arrive as a forced tool call. The `openai-oauth` row was previously silent on both.

- **CHANGELOG 2.25.2 entry made accurate.** The 2.25.2 description now matches what the file actually delivered (forced + `tool_choice: any` cases in both non-stream and stream variants; tool-result follow-up and parallel cases on non-stream only; reasoning-shape exercise on the forced case only). The false "Each non-stream case is repeated as a stream case" claim is removed and "Reasoning shape is exercised twice" is qualified to the forced case.

Refs #182, #193, #196.

## [2.25.4] — 2026-10-11

### Fixed

- **`bin/smoke` second follow-up from the #192 review.** The OpenAI-shape graders (`/v1/chat/completions`, `/v1/responses`) do not throw on the listed shapes: each is FAIL `malformed-body`, not a throw that escapes `driveLeg` and rejects `runLegs`. A `finish_reason` or `error.message` that cannot be coerced to a string still throws, and the `driveLeg` backstop reports it as FAIL `malformed-body:<error>`. Not every malformed shape is caught at this version: a `/v1/responses` `output` mixing a bad element with a `function_call` still passed (fixed in 2.25.6), and the elements of `tool_calls` are not inspected. Every documented malformed shape is covered — `{"choices":[null]}`, `{"choices":[{"finish_reason":"tool_calls","message":{"tool_calls":null}}]}`, `{"output":"x"}`, `{"output":{}}`, `{"output":[null]}` and `{"output":null}` — and a `driveLeg` try/catch catches any throw the type guards let through (a body whose `stop_reason` is a non-coercible object, used in a template literal) so the runner reports FAIL `malformed-body:<error>` and `runLegs` still resolves for the remaining legs. The reasoning leg no longer double-emits `missing-tool-use`: the `end_turn` cases return exactly `stop-end_turn,missing-tool-use` (no tool_use block) or `stop-end_turn` (a tool_use block with the expected name is present). Process-level tests spawn the `bin/smoke` wrapper with `--key=abc` and `--url http://127.0.0.1:1 --model m --key-env mar_live_x` and assert exit `64` and that neither stdout nor stderr contains the typed value, and a connection-refused test confirms every required leg is INCONCLUSIVE with a non-`key-unset` reason and the exit code is `2`. The reasoning leg's upstream body is asserted to carry `tools`; the rendered report contains `thinking=no` for a leg that came back without a thinking block. The dead `responses_function_call` case in `buildChatCompletionsBody` is gone (the `/v1/responses` leg's expectation never reaches the chat-completions body builder). `apps/api/smoke/grade.ts` stays under the 300-line ceiling with the OpenAI graders split into `apps/api/smoke/grade-openai.ts`. Type casts on parsed response bodies remain in `grade.ts` and `grade-openai.ts`; the shape guards that run before them are what make a malformed body FAIL, not the casts. Refs #183, #189, #192, #194.

## [2.25.3] — 2026-10-11

### Added

- **GPT-6 price rows.** Four new entries in `apps/api/src/services/cost/tables/openai.ts` — `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol` and `gpt-6-astra` — in the same `tiered(...) at LONG_CONTEXT_FROM` shape the GPT-5.6 rows use. Standard card: input / cached input / cache write / output USD per 1M tokens, read 2026-10-10 from the model pages under `https://developers.openai.com/api/docs/models/`. Long card: 2× input and cache, 1.5× output, for the whole request once the prompt (`tokensIn` plus cache read and cache write tokens) reaches 272,000 (the same threshold the GPT-5.6 rows already use). Both `openai-api` and `openai-oauth` read the one table, so the new rows cover metered API traffic and the connected ChatGPT subscription. The unit suite (`apps/api/test/unit/cost/estimate.test.ts`) pins the three documented arithmetic cases on `gpt-6-luna` (200k + 200k = 0.120000, 1M + 1M = 0.950000 on the long card, 300k in and no output = 0.060000) and pins `gpt-6.1-sol` on an `openai-oauth` subscription as `notional` with a non-null cost. The unit suite (`apps/api/test/unit/cost/account-prices.test.ts`) pins `unpricedModels` reporting none of them as `missing_rate` on either surface, and still flags `gpt-reserve` and `codex-auto-review` as unpriced. `PRICE_SOURCES` is unchanged (`openai` keeps `verifiedAt: null` and `inherited(...)`), and the diff touches no file under `apps/api/src/services/models/windows/` and not `apps/api/src/services/cost/provenance.ts`. Docs: `docs/idea/08-observability.md` "Cost estimation" gains a paragraph that names the four models, their provenance page and date read, and the long-context rule.

## [2.25.2] — 2026-10-11

### Added

- **Tool-call integration tests through the OpenAI drivers.** New `apps/api/test/integration/openai-tools.test.ts` covers four tool-call shapes that GPT-6 model traffic actually produces — a forced tool call (`tool_choice: {type: "tool", name}`), `tool_choice: {type: "any"}`, the tool-result follow-up turn, and parallel function calls — against `/v1/messages` into an `openai-oauth` account (Codex subscription, dialect `openai-responses`). The forced tool and `tool_choice: any` cases are exercised in both a non-stream and a stream variant; the tool-result follow-up and parallel cases run on the non-stream leg only. The same file covers `/v1/messages` into an `openai-api` account pinned to `openai-responses` for the forced tool and `tool_choice: any` cases on the stream leg, and a `/v1/chat/completions` case into a Responses-speaking account over an SSE upstream reply. Reasoning shape is exercised twice on the forced-tool `/v1/messages` + `openai-oauth` case alone (absent and `thinking: {type: "adaptive"}` plus `output_config: {effort: "low"}`). A `UsageRecord` row per request, with `cost_basis: "notional"` for `openai-oauth` and `cost_basis: "metered"` for `openai-api`, pins the billing model the operator saw.

### Documentation

- **`docs/idea/06-protocol-translation.md` records one rule and one edge.** (The structured-output refusal described below was already a separate row and was not restated as an edge here.) The GPT-6 rule: Chat Completions accepts tool calls only when the client sent `reasoning_effort: "none"`; the router never adds that (`openAiEffortFromAnthropic` produces no level for `adaptive` or `disabled`), so an OpenAI account that must serve tools speaks Responses. The edge: `anthropicToOpenAiResponsesRequest` forwards `temperature` / `top_p` verbatim, and the Responses API rejects them when reasoning is on — the Codex subscription path drops them at the egress (`CODEX_RESPONSES_EGRESS`); `openai-api`'s Responses surface does not. It points at the existing structured-output row: `response_format: json_schema` is refused across dialects, so a structured call must arrive as a forced tool call. `docs/idea/03-providers.md` carries the GPT-6 rule on the `openai-api` row.

## [2.25.1] — 2026-10-11

### Fixed

- **`bin/smoke` follow-ups from the #186 review.** The redaction test now drives the real runner with a real env var and asserts the key never reaches plain stdout, plain stderr, or the JSON `keyEnv` field — the earlier test pinned a value (`sk-test`) that never entered the runner and passed regardless of what the runner printed. A new subprocess test (`bun spawn` of `apps/api/smoke/run.ts`) covers what `main()` itself writes. The reasoning leg sends `thinking: {type: "adaptive"}` plus `output_config: {effort: "low"}` (the spec the Luna route returned on 2026-10-11) and grades PASS on a `tool_use` block alone — adaptive makes the block optional, and the Responses-translated route never returns one when the upstream gives no summary text. The grader reports thinking presence as `thinking=yes` / `thinking=no` on the report line. The grader call now sits outside the fetch `try`, so a body whose `content` is `"x"`, `[null]` or has an element without a type grades FAIL `malformed-body` and exits 1 (a `stop_reason` or `error.message` that cannot be coerced to a string still threw out of the runner, exit 64, until the 2.25.4 backstop); the OpenAI-shape graders are NOT total at this version, so an OpenAI-side malformed body still throws out of the runner (fixed in 2.25.4). `parseArgs` refuses `--key-env` values that are not identifiers or that start with `ROUTER_KEY_PREFIX` (`mar_live_`), and reports "unknown option at position N" without echoing the typed value, so `--key=abc` and `--key-env "$KEY"` are usage errors that never print the value. The runner file split (`args.ts`, `legs.ts`, `sse.ts`, `report.ts`, `grade.ts`, `run.ts`) keeps every file under the 300-line ceiling in `CLAUDE.md`; `run.ts` is now the composition root. The unit suite (`apps/api/test/unit/smoke/grade.test.ts`) pins the grader's verdict for every documented shape, including the malformed-body and thinking-optional cases; the integration suite (`apps/api/test/integration/smoke.test.ts`) drives the runner end to end, asserts `harness().upstream.calls` carries `tools`, the mapped `tool_choice` and the reasoning effort upstream, and spawns `bun apps/api/smoke/run.ts` as a subprocess for the redaction check (the `bin/smoke` wrapper itself is spawned from 2.25.4). Refs #183, #186, #194.

## [2.25.0] — 2026-10-11

### Added

- **`bin/smoke`, a one-command live check against a deployed router.** Sends the same six legs the router promises end to end (`/v1/messages`: plain text, forced tool call, `tool_choice: any`, the tool-result round trip, a streamed forced tool, and reasoning plus a forced tool) plus two informational legs on `/v1/chat/completions` and `/v1/responses` that an account may legitimately refuse and that never gate the exit code. The grader is a pure function in `apps/api/smoke/grade.ts`; no request or response body is logged in full, just the leg name, status and verdict reason. Reads the API key from the named environment variable only — at 2.25.0 an unknown argument's value, or a key-shaped `--key-env` value, could be echoed (fixed in 2.25.1); from 2.25.1 on the key is never accepted as an argument and never printed. Exit codes: `0` every required leg PASS, `1` any required FAIL, `2` no FAIL but at least one INCONCLUSIVE (key unset, DNS, timeout), `64` usage error. Docs: `docs/clients.md` ("Run the live check"); CLAUDE.md Commands table. The unit suite (`apps/api/test/unit/smoke/grade.test.ts`) pins the grader's verdicts for every documented shape; the integration suite (`apps/api/test/integration/smoke.test.ts`) drives the runner end to end against a mocked upstream so no real provider is ever reached. At this version the key-redaction test could not fail and the reasoning leg sent `thinking: enabled`; both are fixed in 2.25.1.

- **Codex usage gauge: `x-codex-primary-*` and `x-codex-secondary-*` headers on every ChatGPT reply are now parsed into the router's `QuotaWindowState` vocabulary.** A complete set (used-percent, window-minutes, reset-at) maps to `five_hour` (300 minutes) or `seven_day` (10,080 minutes); an unmatched minute count travels as a generic `RateLimitWindow`. Every named window carries `advisory: true`, a display-only marker that survives persistence: `isWindowSpent` returns `false` for it, so `quota-window-spent` never fires on a header reading. The admin view shows `spent: false` for an advisory window even at utilization 1 — the marker is what the operator's display-only ruling is recorded against. The rule exists because the `openai-luna` pool has one member — letting a 100% reading drop it would switch Luna off for up to seven days on the router's own say-so. The credits headers (`x-codex-credits-has-credits` / `-unlimited` / `-balance`) are deferred to #185. Schema: a new `advisory boolean NOT NULL DEFAULT false` column on `quota_windows` (migration `0032_quota_windows_advisory.sql`). Sibling file `apps/api/src/providers/drivers/openai-oauth-quota.ts` keeps `openai-oauth.ts` under its 300-line ceiling. Verified against the live upstream code (`openai/codex/codex-rs/codex-api/src/rate_limits.rs`, lines 70..79 on 2026-10-10). Docs: `docs/idea/02-domain-model.md` ("Quota window state"), `docs/idea/03-providers.md` ("`openai-oauth`"), `docs/idea/05-routing-and-failover.md` reading table, and `docs/idea/08-observability.md` ("Quota, resets, and manual re-check"). CLAUDE.md "33 migrations (through 0032)" reflects the new schema state. Test suites: the unit suite (`apps/api/test/unit/providers/openai-oauth.test.ts`) pins every documented parse shape and the driver's `parseRateLimit` end-to-end; the unit suite (`apps/api/test/unit/routing/quota-advisory.test.ts` and `apps/api/test/unit/recovery/quota-advisory-roundtrip.test.ts`) pins the marker on `isWindowSpent` and the in-memory round-trip through `toQuotaEvidence`; the integration suite (`apps/api/test/integration/codex-quota-gauge.test.ts`) drives the dispatcher against the real database end-to-end; the integration suite (`apps/api/test/integration/codex-quota-advisory-roundtrip.test.ts`) walks the marker through the SQL path (`upsertQuotaWindow` → `loadCatalog` → `overlayHealth` → `toQuotaEvidence`) without dispatching a request.

### Rollback note

A pin-back to `2.24.x` or `2.23.6` keeps the new `quota_windows.advisory` column but the older `toQuotaEvidence` drops the marker on read. Any `openai-oauth` window persisted at `advisory = true` while on 2.25.0 falls back to the old path: a 100% reading with a future reset will block the one-member `openai-luna` pool as `quota-window-spent` until either reset-at (up to seven days for `seven_day`) or a manual **Re-check** on the account retires the window through the recovery path. Before a pin-back: either retire the affected windows first (operator `Re-check` after the utilization comes back under the threshold) or accept the temporary single-account outage. Cross-reference #185.

## 2.24.0 — 2026-10-11 (not released; its contents first ship in 2.25.0)

Never tagged. The `bin/smoke` addition is listed under 2.25.0.

## [2.23.6] — 2026-10-07

### Fixed

- **Claude Code subagents get their own SDK session.** Claude Code sends the parent's `x-claude-code-session-id` and `metadata.session_id` on every subagent request, and opens each one with the same `<system-reminder>` blocks, which filled the whole 1,024-byte fingerprint window. The parent and all its subagents resolved to one session key: parallel subagents detached and replayed fresh, and sequential ones overwrote the parent's lineage so its next turn replayed too. The scanner now skips reminder blocks while it streams, so the window holds the task text. Verified against 51 requests captured from Claude Code 2.1.292 running three subagents on a stub upstream: one key before, four after (parent plus one per subagent). Claude Code conversations start fresh once after the upgrade; other clients' keys are unchanged.

## [2.23.5] — 2026-10-07

2.23.4 matched only the untitled form of the 2.1.289 refusal. Two resumes still answered `502` (prod, 2026-10-07 13:28).

### Fixed

- **A titled session's busy refusal is recognised.** CLI 2.1.289 leads the refusal with the session's quoted title (`"<title>" is running in the background (<job>).`) and says "That session" only for an untitled one. Claude Code's sessions are titled, so they still fell to `claude-sdk:subprocess-exit`. The rule now matches the predicate, `is running in the background`, and the in-place fork recovery runs. Read from the bundled CLI's message builder.

## [2.23.4] — 2026-10-07

2.23.3 confirmed in prod: Claude Code turns resume, cache writes fell from 240 k to 48–983 tokens a turn. Two resumes still answered `502` (prod, 2026-10-07 05:15).

### Fixed

- **The CLI's 2.1.289 busy-session wording is recognised.** A resume that arrives while the previous turn's process is still exiting is refused with "That session is running in the background", on stderr behind `exit 1`. It fell to `claude-sdk:subprocess-exit` (`502`) instead of `busy-session`, so the in-place fork recovery never ran. Verified against the bundled CLI: the refusal now classifies busy and `--fork-session` answers.

## [2.23.3] — 2026-10-07

2.23.2 lifted the tool-result rule, but Claude Code turns still started fresh in prod: turn 2 read as `diverged`, later turns as `no-rollback-point`.

### Fixed

- **A message re-sent as a string hashes the same as its single text block.** Claude Code (2.1.292) sends its mid-conversation `system` message as a `cache_control`-marked block array on the turn it is newest and as a bare string afterwards. Lineage hashed the two apart, so the next turn never matched the stored history and replayed it all. Verified against bodies captured from the real CLI on a stub upstream: every turn now classifies as `continuation`. Existing session lineages hashed string content the old way and start fresh once after the upgrade.

## [2.23.2] — 2026-10-07

Claude Code behind the router burned its Claude subscriptions roughly ten times faster than it should, then hit `429`s with every window spent (prod, 2026-10-07). Each agentic step ran as a fresh SDK session that replayed the whole conversation as text: `cache_read` sat at the tools+system floor (86 k) on every turn while `cache_write` grew with the transcript, to 240 k tokens a turn.

### Fixed

- **Claude Code tool rounds resume their SDK session.** A fingerprint-keyed turn ending in a `tool_result` always started fresh, to keep concurrent headerless loops apart — and Claude Code ends every step that way. Its `x-claude-code-session-id` header now lifts that rule and is mixed into the fingerprint, so its own conversations stay apart without keying on an id the CLI reuses for one-shots and subagents. Lineage still decides resume vs fork vs fresh.

### Added

- `sdk session plan` log line per Agent SDK attempt: plan kind, and the reason when it is `fresh`.

## [2.23.1] — 2026-10-07

Every Claude subscription request since 23:16 the night before landed on one account while five others sat behind recovery rows that never cleared (prod, 2026-10-07).

### Fixed

- **A recovery permit is spent, not wasted.** The account holding a designated recovery permit now ranks ahead of healthy accounts, so the next request settles it. Ranked last, the permit expired unused every cycle (38 times on one subscription) and the account never rejoined rotation.
- **A pending recovery no longer starves the credential keepalive.** Background turns are held off only by an `issued` permit or a `failed`/`uncertain` attempt inside its `next_allowed_at`. A `pending` row has nothing in flight; gating on it skipped the keepalive of an unrouted subscription every tick until its login went cold.

### Added

- `recovery-promoted` policy note.

## [2.23.0] — 2026-10-07

When accounts go bad the router now finds a good one instead of answering `429` while a healthy subscription sits in scope. A request may take a few seconds longer; it lands. Prod, 2026-10-06: the four Claude subscriptions behind one key answered `429` for minutes after two of them were reconnected, while the other two kept being probed although their weekly windows were spent until 2026-10-08 (#167).

### Upgrade notes

- **New optional setting:** `RECOVERY_REQUEST_WAIT_MS` (default `5000`, `0` disables) — how long a request waits for the router's own recovery hold before answering `429`.
- **A reconnect or enable is routable immediately.** Its recovery generation is published settled (`cancelled`) rather than `pending`; the console shows the generation as cancelled.

### Fixed

- **Reconnect no longer gates the account.** A just-verified login published a `pending` recovery and every request was refused as `probe-in-flight` until an on-demand permit arrived.
- **Spent windows are not probed.** Recovery permits no longer capture a quota window whose reset the provider reported and has not arrived; the filter reports a provider-reported spent window or cooldown before the router's own holds, so the `429` names the real reset instead of "settling a recovery probe, <1 s".
- **A blocked binding moves.** With session carry on, a session bound to an account that cannot serve now is placed on another eligible account and its transcript carried, for every clock-recoverable reason including a probe in flight. With no alternative the binding is kept and the `429` carries its reset.
- **Router-own holds wait instead of `429`.** A request blocked only by a recovery awaiting its permit (or another request's probe) waits up to `RECOVERY_REQUEST_WAIT_MS` and re-selects; a chain that sent nothing and ended on a permit refusal re-plans the same way, and its give-up `429` carries the short refusal `Retry-After`, not another account's days-away reset.
- **A client cancel after model output is a success.** It settled the recovery `uncertain` and re-gated an account that had just answered.
- **A failed attempt no longer claims the conversation.** The CLI names its session before it learns the window is spent; that report is now withdrawn, so the binding stays where the conversation was answered and the retry carries from there.

### Added

- Info logs for every candidate the chain drops without an upstream attempt, and for every bound turn that starts fresh instead of carrying (with the reason).

## [2.22.0] — 2026-10-05

A Claude subscription conversation now survives a switch to another subscription. When the bound account runs out of quota, cools down, or loses its login, the next subscription carries the conversation's SDK transcript into its own config directory and continues it — the router's equivalent of a local `/login` mid-session — instead of restarting it.

### Upgrade notes

- **New optional settings, both defaulted:** `CLAUDE_SDK_SESSION_CARRY` (`true`), `CLAUDE_SDK_SESSION_CARRY_MAX_BYTES` (32 MiB). `false` restores restart-on-failover.
- **`x-router-session-restart` is now set only when history was actually lost.** A turn that carried its session to another account sends no header.

### Changed

- **Failover keeps the conversation.** A turn that lands on a different subscription than its binding (preflight `rebind`, an exhausted / `needs_reauth` / out-of-scope bound account, or a mid-chain hop off a spent window) copies `projects/<slug>/<session>.jsonl` from the bound account's `CLAUDE_CONFIG_DIR` to the serving one's — transcript only, never a credential; symlinks refused on both sides; atomic rename; both accounts' owner holds — and continues it with the same delta a resume would send, forked at the last recorded answer so a failed attempt's appended tail stays behind. Previously the binding was dropped and the whole history was replayed as framed text on a fresh session: lossy, and in production ~670k tokens per turn.
- **A refused binding is kept, not cleared.** Only the turn that answered on the new account re-points it. A carry that cannot happen (transcript swept, too large, owner refused) starts fresh exactly as before and is logged and surfaced.

## [2.21.1] — 2026-10-05

### Fixed

- **Claude subscriptions lost the user's message after a hidden one-shot.** Claude Code fires a prompt-suggestion request after each answer; it resumed and advanced the conversation's SDK session, so the real next turn arrived with the stored tail replaced. The lineage read that as a modified continuation and sent only what lay past the stored end — the bare `<total_tokens>` reminder — and the model answered "I don't have the earlier conversation". A replaced tail is now its own `rewrite` class: fork at the last shared answer and send the turn from there (fresh replay when no rewind point is known).
- **Every resumed turn re-sent the session's own last answer** inside a "could not be resumed" `<prior_conversation>` frame. A resume delta now skips the echoed answer, so a normal turn reaches the model as itself.

## [2.21.0] — 2026-10-05

Claude subscription logins: see when each one needs renewing, renew the expiring ones in one guided run, and keep idle accounts' access tokens fresh.

### Upgrade notes

- **Migration 0031** adds two scheduled-task names (`credential_keepalive`, `login_lifetime_watch`). Additive only.
- **New optional settings, all defaulted:** `CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS` (28), `CLAUDE_LOGIN_RENEWAL_WARN_DAYS` (5), `LOGIN_LIFETIME_WATCH_INTERVAL_MINUTES` (1440), `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS` (180), `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_RETRY_MINUTES` (60).
- **A small, bounded number of extra subscription turns.** The credential keepalive spends one minimal turn on an idle subscription only when its access token enters the CLI's own 5-minute refresh lead — roughly one turn per idle account per access-token lifetime. Never for `needs_reauth` or disabled accounts.

### Added

- **Login lifetime.** Each Claude subscription shows "Login renews in N days", `reported` when the CLI wrote `refreshTokenExpiresAt`, otherwise `estimated` from the last interactive login plus `CLAUDE_LOGIN_ASSUMED_LIFETIME_DAYS`. The admin account API carries `renewsAt`, `renewsAtSource`, `daysUntilRenewal`, `renewalRequiredSoon`, `lastLoginAt` and `accessTokenExpiresAt` (timestamps only).
- **Reconnect expiring.** A console action runs the guided reconnect over only the subscriptions inside the warn window; the dashboard banner lists them.
- **`claude subscription login renewal due`** — one warn log line per account per day inside the window, for alerting.

### Fixed

- **Idle subscriptions' access tokens lapsed for hours.** The idle probe ticked every 6 h and only warmed a token inside a 10-minute window, while the CLI refreshes only in its last 5 minutes, so idle tokens almost always expired first. The new keepalive checks timestamps every 180 s and turns only when the CLI would refresh, logging whether the refresh moved the login expiry.

## [2.20.0] — 2026-10-04

### Added

- **Model sizes on `/v1/models`.** Anthropic-shape entries carry `max_input_tokens` / `max_tokens` (null when unknown); OpenAI-shape entries carry `context_length` / `max_completion_tokens` when known. Values come from each provider's own listing where it states them (Anthropic `max_input_tokens`/`max_tokens`, Codex `context_window`, OpenRouter `context_length`/`max_completion_tokens`, vLLM `max_model_len`), otherwise the shipped tables, served from the warm catalog. Note: Claude Code does not read sizes from a custom endpoint today; set `CLAUDE_CODE_MAX_CONTEXT_TOKENS` client-side.

### Fixed

- **`gpt-6.1-sol[1m]` (Claude Code's "Default" with a context tag) was a 503 "no account serves model".** A trailing context tag like `[1m]` is a client hint: on providers that don't understand it the router matches and sends the base name. Claude subscriptions still receive the tag. An explicit alias or listing of the tagged name wins.
- **Usage recorded zero tokens when the final stream event exceeded `UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES`** (Codex `response.completed` echoes the request, ~224 KB in prod). Oversized frames are now scanned once as they pass, retaining only the usage/status fields within the same cap.

## [2.19.1] — 2026-10-04

### Fixed

- **Claude Code on a ChatGPT/Codex account got a malformed response.** The Codex backend answered with an event stream and no `text/event-stream` content-type, so the router took the JSON path and passed the raw Responses SSE through: streaming clients saw no events, non-streaming clients got SSE. A translated request to a forced-stream account now sends `Accept: text/event-stream` and reads the body as SSE regardless of content-type, and its usage is observed as a stream.
- **ChatGPT/Codex "Test now" and the idle probe failed with "Input must be a list".** The probe now sends `input` as a list of message items.
- **An `uncertain` recovery blocked an account until an operator pressed Re-check.** It now holds only until its `nextAllowedAt` (the recovery cooldown when its owner recorded it; the maximum outcome age when the permit may still be on the wire), then the next automatic hint starts a fresh probe. A probe hold is reported as "settling a recovery probe", not as quota.


## [2.19.0] — 2026-10-04

One key can now span Claude subscriptions, a ChatGPT/Codex subscription and Chinese-model accounts, and the model name picks the family. Reasoning settings reach every path. (#160)

### Upgrade notes

- **No migrations, no new settings.**
- **Claude and ChatGPT/Codex subscription accounts no longer accept every model name** when they declare no supported models. They accept their own family: `claude-*` plus the CLI aliases (`opus`, `sonnet`, `haiku`, `fable`, `best`, `default`, `opusplan`, with `[1m]` tags) for Claude, and `gpt-*`, `codex-*`, `o<n>` for ChatGPT/Codex. An Account's explicit supported-model list still wins.
- **ChatGPT/Codex accounts connect only with a code.** The paste-back flow is refused with `device_only` for providers that declare device sign-in.

### Fixed

- **Mixed keys sent models to the wrong family.** `k3` and `MiniMax-M3` reached a Claude subscription and `claude-opus-5-5` reached a ChatGPT account. Each failure struck the account's breaker and pinned the session to it, so later requests got `429` "settling a recovery probe".
- **A model refusal now fails over.** "Issue with the selected model" (Claude) and "not supported when using Codex" are a retryable `model-unsupported` failure before any bytes are sent, with no breaker strike.
- **Native names before aliases.** When some accounts serve a name natively and others only through an alias rename (`claude-opus-5 → glm-5.2`), the native accounts are tried first.
- **ChatGPT/Codex model discovery and Test now returned `400`.** Discovery now sends `client_version`; the account test and idle probe send a Codex-valid streamed request. Both failures now log the provider's (scrubbed) message.
- **OpenRouter "Key limit exceeded (total limit)" is credits-exhausted**, not a rejected credential.
- The device sign-in dialog keeps checking while its tab is in the background, and a completed sign-in logs `device login completed`.

### Added

- **Thinking and effort on Claude subscriptions.** `thinking` and `output_config.effort` are passed to the Agent SDK when the client sends them. The tool lockdown is unchanged.
- **Effort across dialects.** `reasoning_effort` / `reasoning.effort` ⇄ `output_config.effort`; encrypted reasoning items from Responses clients are dropped and reported instead of refused; Responses reasoning summaries come back as Anthropic thinking blocks.

## [2.18.0] — 2026-10-04

Sign in to ChatGPT/Codex with a code, the way `codex login --device-auth` does on a remote server. (#158)

### Upgrade notes

- **No migrations, no new settings.** The code-based sign-in uses the existing `RETENTION_OAUTH_STATE_MINUTES` (default 10) as its time limit.

### Added

- **Device-code sign-in for ChatGPT/Codex accounts.** In the connect dialog, **Get a code** shows a short code and `https://auth.openai.com/codex/device`; enter the code from any browser and the dialog completes by itself. Nothing has to reach `localhost:1455`, so it works when the browser cannot follow the loopback redirect. Keep the dialog open until it says Connected: its status poll is what checks back with OpenAI (at most once per OpenAI-stated interval, backing off on `429`). OpenAI's device id and the exchanged tokens never leave the router; only the user code and the page link are shown.

## [2.17.0] — 2026-10-04

ChatGPT/Codex subscriptions work end to end, from any client dialect. (#156)

### Upgrade notes

- **No migrations, no new required env vars.** `PUBLIC_URL` no longer affects ChatGPT/Codex connect: auth.openai.com only accepts the Codex loopback `http://localhost:1455/auth/callback`, so connect is always paste-back. After signing in, the browser shows a "can't connect" page on localhost; copy the whole address bar URL into the console. An `openai-oauth` account created on 2.16.x and left in `needs_reauth` connects with a fresh **Reconnect**.

### Fixed

- **ChatGPT/Codex connect never completed when `PUBLIC_URL` was set.** The authorize URL named the router's own callback, which the Codex client id does not register, so no code was issued. The console also reported "Connected" off the `updatedAt` bump that starting a connect writes; it now reports success only when the account shows a new credential.
- **A stalled Claude subscription turn could hang forever.** Upstream pings and SDK `keep_alive` messages re-armed the 90 s idle deadline; only real model output does now. A timer that fires late after an event-loop stall re-reads buffered data once before answering `504`.
- **Mid-conversation `role: "system"` messages were a `400`.** They are accepted on Claude subscriptions (including `clear_at` and `tool_addition`/`tool_removal`) and translated to `system` (chat completions) or `developer` (responses) for OpenAI-dialect accounts.

### Added

- **Anthropic `/v1/messages` and OpenAI `/v1/chat/completions` clients can use ChatGPT/Codex accounts.** The driver declares Codex's request rules (streamed, `instructions` set, `max_output_tokens`/`temperature`/`top_p` dropped); a client that did not ask to stream gets the upstream stream collected into one response, and a streaming client is forwarded unbuffered. `/v1/responses` stays byte-passthrough.
- Codex requests carry the `originator` header and the authorize URL the Codex CLI parameters; the ChatGPT account id is also read from a top-level token claim.

### Changed

- `@anthropic-ai/claude-agent-sdk` 0.3.289 (CLI 2.1.289), `hono` 4.13.13.

## [2.16.0] — 2026-10-04

Driven by the full-router audit (plans 101 and 102): credential containment, multi-replica correctness for recovery, refresh and quota, durable usage history, and bounded resources everywhere. (#141–#154)

### Upgrade notes

- **Six migrations, 0025–0030, all additive at the data level.** None rewrites or scans a large table. They add `accounts` lifecycle, health-recovery and auth-recovery versions plus `authorization_attempt_id`, and `oauth_states.authorization_lifecycle_version` (0025). They add `quota_windows.revision` and `retired_at` (0026), then `evidence_state` and `blocks_routing` (0027). They create `account_recoveries` (0027) and `account_operator_checks` (0028). 0029 makes `usage_records.model` nullable and adds `response_status`. 0030 adds `usage_request_terminals`, `usage_contributions`, `usage_history_state`, `usage_attempt_daily_v2` and `usage_request_daily_v2`. It also adds `price_overrides.account_id`, replacing the `(provider, model)` unique index with `(account_id, provider, model)`, and adds `usage_records.ingested_at`, which is nullable and defaults to `clock_timestamp()`. On `usage_records`, 0030 drops the foreign keys to `api_keys`, `accounts` and `pools`, so historical dimensions survive deletion of what they name. Changes to `usage_records` and `usage_daily` touch catalog metadata only. They still take a brief exclusive lock, so the migration waits behind any long-running query on those tables.
- **0030 seals `usage_daily`.** A trigger refuses every insert and update, so the legacy rollup can no longer write it. A second trigger skips deletion of a raw `usage_records` row whose history has not been registered yet. **During a rolling upgrade, a 2.15.x replica's usage rollup fails against the sealed table, and its janitor's raw deletes are silently held back, until that replica is replaced.** Existing raw rows are adopted into the new history in bounded batches by the usage-rollup task (`USAGE_ROLLUP_INTERVAL_MINUTES`), not by the migration.
- **A pending browser authorization started before the upgrade needs a fresh login.** Its OAuth state carries no lifecycle binding.
- **Shutdown takes longer, and is bounded at 55 s with defaults.** The bundled compose `stop_grace_period` goes from `30s` to `60s`. On Kubernetes, set `terminationGracePeriodSeconds` to at least `80` with the default drains and a 20 s readiness window. Shutdown now runs every cleanup phase even after one fails, and exits `1` when any phase reported failure.
- **Each replica opens up to two more Postgres connections.** The scheduler (`SCHEDULER_LOCK_POOL_MAX_CONNECTIONS`, default 1) and the OAuth refresher (`OAUTH_REFRESH_LOCK_POOL_MAX_CONNECTIONS`, default 1) each have a dedicated advisory-lock pool outside `DB_POOL_MAX`. Count all three ceilings against the server's connection budget.
- **Claude subscription work requires the native ownership helper.** The image ships it at `/usr/local/libexec/router-cli-owner` and sets `CLAUDE_OWNERSHIP_HELPER_PATH` to that path. A standalone `dist/` deployment points the variable at `dist/libexec/router-cli-owner`. On Linux, `bin/setup` builds it at `native/config-owner`, which needs a C compiler and static libc headers. When the helper is missing or unusable, CLI admission is refused.
- **`USAGE_BATCH_SIZE` is now bounded at `1..2340` (was `1..2520`), because a usage row now binds 28 parameters.** A value from 2341 to 2520 fails boot.
- **`ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` must be less than `ADMIN_SESSION_IDLE_MINUTES * 60`.** The check applies to resolved defaults too, and boot refuses a configuration that fails it.
- **The bundled and development compose files pin `postgres:16.15` by digest** (was `postgres:16`). The data directory is unchanged. CI also covers PostgreSQL 18.6.

### Fixed

- **Upstream credentials are contained.** Upstream error bodies are read up to `UPSTREAM_ERROR_MAX_BYTES`, and a body over that limit is replaced whole rather than truncated. Known credential patterns, the selected account's credential and private driver headers are all scrubbed before an error is logged or returned. Upstream redirects are refused instead of followed. Only an allowlist of client protocol headers reaches a provider.
- **Subscription sessions are isolated per router key.** Claude session aliases are scoped by router key and account, and an actual SDK session is claimed without serializing independent conversations. The session fingerprint now covers up to 1,024 raw bytes of the first non-empty user item, scoped to the key. A request with no usable user opening gets a fresh, unbound session instead of sharing an inferred one.
- **Claude prompts are passed verbatim.** Every SDK query sets `verbatimPrompts: true`, so the CLI never dispatches slash commands or expands `@path` from client text. This needs `claude` 2.1.248 or newer. The host-tool rejection gate is unchanged.
- **Account mutations are fenced across replicas.** A late refresh, login, request result or probe can no longer overwrite a newer reconnect, credential replacement, disable or delete. Each replica used to exchange the same refresh token on its own. Those exchanges are now serialized through a Postgres advisory lock, and a routine successful refresh keeps the operator's status. The validated ChatGPT account identity is stored inside the encrypted credential and used on egress.
- **Recovery admits one designated upstream start per durable generation, fleet-wide.** Previously each replica could fire its own half-open probe. Other callers now get a counted `429` with `Retry-After` (`RECOVERY_RETRY_AFTER_MS`) and no health strike against the account. A failed probe renews the cooldown, and a lost outcome is recorded as `uncertain` and never reissued. A spent window with no named reset becomes eligible for recovery after `ROUTING_QUOTA_STALE_AFTER_MS`.
- **Quota evidence is monotonic.** A late or replayed write can no longer replace a fresher provider reading, and an expiry sweep can no longer clear a window that was updated after it was scanned. Equal-time readings keep the higher utilization and the later reset. A late SDK quota event or gauge reading from a replaced credential or recovery generation is discarded. Late restrictions still apply until EOF.
- **Cooldowns honor what the provider said.** Relative reset durations and explicit retry headers now feed cooldown decisions, and depleted limiter constraints are waited out. A fractional client `Retry-After` rounds up, and a missing reset uses the configured fallback. An OpenRouter content-policy `403` is treated as a request failure, not a credential strike.
- **Admin writes are atomic.** Key and pool writes commit their row, scope or membership, and audit record together, and name checks are serialized. A write against a concurrently deleted reference returns `409`. Deadlocks retry the whole transaction. A completed edit can no longer be served by an older in-flight catalog, price or model load. Editing a key no longer resets its spent rate-limit window.
- **Key verification is bounded.** Concurrent cache misses for one key share a single lookup, and an admin invalidation fences any older result. A full lookup queue, or repeated invalidation, returns `503 key_verification_unavailable` with `Retry-After: 1` instead of `401`.
- **Deleting a Claude subscription account no longer removes its config directory while something still owns it.** That covers a running CLI, a pending login, or a metadata read. A Linux subreaper guardian tracks escaped descendants. When an owner is still active or unknown, cleanup is deferred, and the delete response and console say so. Background probes recheck account eligibility after their preparation waits.
- **Usage accounting is complete and causal.** Authenticated refusals before model selection, such as a key's own rate limit, now write a row with a null model. Each request gets a router-minted correlation UUID that callers can no longer join, and each usage event gets a stable retry id. A protocol error inside an HTTP `200` is recorded as the failure it is. The first observed failure and any partial usage survive a later cancellation, and output-limit stops do not strike account health.
- **Usage history survives raw retention.** Attempts and logical requests are now separate facts. A failover verdict is attributed to the account that actually won, and late events land on their original day exactly once. Summaries read one consistent snapshot and disclose when history is legacy-only or incomplete. Chart buckets cover the whole requested range instead of the first 400 days.
- **Request metrics count terminal outcomes.** A stream is counted when it reaches EOF, fails, is cancelled or is cut by shutdown, not when its headers go out, so a stream that failed mid-body no longer counts as a success.
- **Cross-dialect translation keeps tool turns intact.** Parallel Responses tool calls stay in one Chat assistant turn. Streamed refusals, item-id and output-index fragments, tool-result image order, reasoning summaries, no-argument calls, parallel-tool policy and context-window stops are all preserved. Recognized HTTP-200 error envelopes are reported as errors. Conflicting identities, and deferred state that exceeds `MAX_TRANSLATION_PENDING_BYTES`, produce an honest translation error. The tool is never silently truncated, and the request is never retried after bytes are sent.
- **Data-plane JSON is validated through EOF.** Malformed trailing JSON, nesting deeper than `MAX_REQUEST_JSON_DEPTH`, or a duplicate top-level `model` returns `400` before dispatch. Same-dialect bytes still pass through unchanged. The routing scanner stops once it has the facts it needs, which fixes the large-body overhead.
- **Shutdown is bounded and honest.** Scheduler lock sessions no longer use main-pool connections, which used to deadlock bookkeeping and shutdown. Writers close admission, drain their current and final pending work, and report unconfirmed persistence at the deadline. Crashed task rows are reaped.
- **Admin authentication is bounded.** Password hashing has a global concurrency cap, and the number of tracked IPs is capped. OIDC requests have a deadline, and a callback with an unknown, expired or replayed state is refused before the IdP is contacted. Session revocation propagates across replicas within `ADMIN_SESSION_REVALIDATE_SECONDS`. Admin JSON is size-capped after authentication and before parsing. The debugger configuration no longer carries a login literal. That does not rotate copies already taken (#87).
- **Sentry 11 sends errors only.** It runs with an explicit error-only integration list. Data collection, tracing, logs and metrics are off, and serialized envelopes are tested for redaction.

### Added

- **Account-scoped price overrides.** An account override wins over a provider override, which wins over the shipped rate. Settings shows each rate's source, its verification date, and configured models with no known price. Kimi subscription reference prices ship for `k3`, `k3-256k` and `kimi-for-coding-highspeed`, used for attribution only.
- **Recovery progress in the admin API and console.** Recovery progress (`generation`, `state`, `outcomeAt`, `nextAllowedAt`) and `checkInProgress` are now exposed. `lastCheckedAt` may be `null`. Account deletion returns `cleanup: "removed" | "deferred" | "not_applicable"`.
- **Metrics:**
  - `router_pool_model_requests_total{pool_id,model,result}`: terminal requests per configured pair, with `result` one of `success_here`, `success_elsewhere` or `failure`.
  - `router_pool_model_available_accounts{pool_id,model,admission}`: selectable accounts on this replica, with ordinary capacity and recovery capacity reported separately.
  - `router_session_binding_wait_seconds` and `router_usage_admission_seconds` (histograms).
  - `router_task_runs_total` gains `outcome="skipped_capacity"`: this replica's lock pool was full, so the task retries after `SCHEDULER_LOCAL_CAPACITY_RETRY_MS`. Like `skipped_locked`, it is not an error.
  - No metric was renamed or removed.
- **New environment variables, all optional.** Every variable below has a default, and boot refuses any value outside its stated range:
  - `RECOVERY_COORDINATOR_INTERVAL_MS` = `250`, `RECOVERY_COORDINATOR_BATCH_SIZE` = `100`, `RECOVERY_DEMAND_CAPACITY` = `1000`, `RECOVERY_DEMAND_TTL_MS` = `60000`, `RECOVERY_OUTCOME_CAPACITY` = `1000`, `RECOVERY_PREPARATION_LEASE_MS` = `10000`, `RECOVERY_MAXIMUM_OUTCOME_MS` = `600000`, `RECOVERY_COOLDOWN_MS` = `30000`, `RECOVERY_SHUTDOWN_DRAIN_MS` = `15000`, `RECOVERY_RETRY_AFTER_MS` = `1000`, `ROUTING_QUOTA_STALE_AFTER_MS` = `600000`. Timers are 1–2147483647 and capacities 1–100000.
  - `RECOVERY_OPERATOR_CHECK_LEASE_MS` = `30000`. **Boot refuses values below `17000`.**
  - `BACKGROUND_SHUTDOWN_DRAIN_MS` = `15000`. `SCHEDULER_LOCAL_CAPACITY_RETRY_MS` = `1000` (≤ 60000). `SCHEDULER_LOCK_POOL_MAX_CONNECTIONS` = `1` (≤ 100). `OAUTH_REFRESH_LOCK_POOL_MAX_CONNECTIONS` = `1` (≤ 32).
  - `CLAUDE_OWNERSHIP_HELPER_PATH` = `native/config-owner`; the image sets `/usr/local/libexec/router-cli-owner`.
  - `CLAUDE_OWNERSHIP_MAX_OWNERS_PER_ACCOUNT` = `64` (≤ 4096), `CLAUDE_OWNERSHIP_TERM_GRACE_MS` = `1000` (≤ 60000), `CLAUDE_OWNERSHIP_POLL_MS` = `25` (≤ 1000), `CLAUDE_OWNERSHIP_MAX_CHILDREN` = `256` (≤ 65536), `CLAUDE_OWNERSHIP_ADMISSION_TIMEOUT_MS` = `10000` (≤ 60000), `CLAUDE_OWNERSHIP_CLEANUP_MAX_ENTRIES` = `100000` (≤ 10000000), `CLAUDE_OWNERSHIP_CLEANUP_MAX_DEPTH` = `64` (≤ 256), `CLAUDE_OWNERSHIP_OPERATION_TIMEOUT_MS` = `15000` (≤ 60000).
  - `MAX_REQUEST_JSON_DEPTH` = `256` (2–4096). `MAX_TRANSLATION_PENDING_BYTES` = `1048576` (1024–33554432). `UPSTREAM_ERROR_MAX_BYTES` = `65536` (≤ 33554432). `UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES` = `65536` (≤ 1048576). `ACTIVE_REQUEST_MAX_ENTRIES` = `65536` (≤ 1048576); when this is full, requests get a `503` before the body is read.
  - `ADMIN_JSON_MAX_BYTES` = `1048576` and `ADMIN_LOGIN_JSON_MAX_BYTES` = `8192`; a larger body gets a `413`. These two are not in `.env.example`.
  - `ADMIN_LOGIN_MAX_CONCURRENT` = `4`, `ADMIN_LOGIN_MAX_TRACKED_IPS` = `10000`, `ADMIN_SESSION_REVALIDATE_SECONDS` = `60`, `ADMIN_OIDC_REQUEST_TIMEOUT_MS` = `10000`.
  - `USAGE_CHART_MAX_POINTS` = `400` (2–2000) and `USAGE_BREAKDOWN_MAX_ROWS` = `100` (≤ 1000).
  - `METRIC_POOL_MODEL_INVENTORY` = `{}`: a JSON map from pool id to an array of models. It accepts at most 256 pairs, labels of up to 128 characters and 65,536 characters in total, and boot refuses duplicate models. It drives the `router_pool_model_*` series only.

### Changed

- **Re-check now no longer sends anything upstream.** It records a durable recovery intent instead. That intent clears a stored `exhausted` and may run a local `claude auth status`, which can recover `needs_reauth`. The cooldown is shared across replicas. The next designated request is the actual probe.
- **Agent SDK 0.3.288 (bundled `claude` CLI 2.1.288).** Also updated: Sentry Bun 11.4.0, `@solidjs/router` 1.0.0, TanStack Solid Query 5.104.1. Dependency advisories drop from 22 to 0. GitHub Actions and the Dockerfile frontend are pinned by digest. The builder stage adds `gcc` and `libc6-dev` to build the helper. Bun stays at 1.4.2, and `bin/setup` and `bin/check` now enforce that version.

## [2.15.0] — 2026-10-02

Driven by a production incident on 2026-10-02: from 02:18 UTC every `k3` request to pool `cn-models-team` failed, and the router said `1 more needs a human (kimi disabled)` about an account whose stored status was `active`.

### Fixed

- **Kimi's plan-limit `403`s are a cooldown in every wording, not an auth failure.** Kimi announces a spent plan window as `403 permission_error` in at least three phrasings — weekly (7-day), 5-hour, and billing cycle — and the driver knew only the billing-cycle one. The 5-hour body ("You've reached your 5-hour usage limit. Your quota will reset when the current 5-hour window ends.") fell to `403 → auth`. The driver now matches the property (a limit `reached` within one clause of `usage limit`, or a quota that `will reset` / `will be refreshed`), with one signal per window (`kimi:usage-limit-weekly`, `kimi:usage-limit-5-hour`, `kimi:billing-cycle-limit`, and `kimi:usage-limit` for a window not seen yet). The usage row reads `quota_exhausted`, the client gets `429` + `Retry-After`. A genuine `permission_error` ("You do not have access to model …") stays `auth`.
- **A Kimi suspension is never a spent window.** A `403` that names a suspension, ban, deactivation, terms violation or a disabled account/key stays `auth` (`kimi:account-suspended`) even when it also says a usage limit was reached. A *pause* is not a suspension: a body carrying both a reached limit and a clock that reopens it ("Requests are temporarily suspended until the window ends", "temporarily disabled because you have reached your weekly usage limit") is the spent window it describes, and terms wording counts only when it lays a breach at the account's door in the same sentence as the suspension ("suspended for violating our terms"); "Usage is subject to our Terms of Service" is boilerplate, in its own sentence or tacked onto the pause. The usage-limit rules also accept the reversed order ("usage limit reached", "your 5-hour usage limit has been reached") and a pause named by its end ("suspended until your 5-hour usage limit resets").
- **A limiter reading riding a rejected key's response keeps the `credential-rejected` label.** When the response also carried a limiter reset longer than the auth cooldown, the fresh cooldown it built dropped the label and the refused key was reported as an ordinary spent window. The longer instant still stands; the label and the refusal count are the verdict's.
- **A limit that names no instant cools down for an estimated length, not a 1-second backoff.** A classification rule may carry an estimated reset (`withResetEstimate`), applied only when the response reported none and always labeled `estimated` — the pool message reads `earliest reset <t> (estimated)`. Kimi: 15 minutes for the 5-hour window, 60 for weekly and billing cycle.
- **A rejected API key is no longer the operator's `disabled`, and no longer permanent.** An `api-key` or `none` account's `401`/`403` used to park it at an in-memory `disabled`: never probed, never timed out, cleared only by Re-check or a restart, and reported as `disabled` while the row said `active` (the console offered an Enable button that did nothing). It now cools down as `credential-rejected` for `ROUTING_AUTH_FAILURE_COOLDOWN_MS` and is re-tested by one half-open probe. It is still reported as needing a human — `1 more needs a human (kimi credential rejected upstream, re-checked after <t> (estimated))`, a `503` when nothing else is left — and is never offered as the pool's earliest reset. OAuth is unchanged (`needs_reauth`). The admin view carries `availability.cooldownReason`, and the console says "credential rejected upstream — check the key".

### Added

- `router_credential_rejected{account_id}` gauge: `1` while an account is cooling down because the provider refused its credential. Such an account now reads `router_accounts{status="cooling_down"}` / `router_breaker_state{phase="open"}` like a spent window (through 2.14.0 it read `disabled` / `blocked`), so **re-key any alert on `router_accounts{status="disabled"}` that was standing in for "a key was refused" onto this gauge.**
- `ROUTING_AUTH_FAILURE_COOLDOWN_MS` (default `900000`, `0` refused at boot): how long an account whose API key the provider refused sits out before one request re-tests it, on its first refusal. Each refused re-test doubles it, jittered like every other cooldown step, and a success starts the count over. A refusal counts once, not once per response: requests already in flight when the key was refused come back too — refused, or answered `5xx` or `429` — and while that cooldown runs none of those verdicts, of any kind, moves the count or the label. Only the re-test does. The cooldown is never shortened, and the one thing that still lengthens it is a limiter reset the provider itself named on one of those responses, when it is the later instant.
- `ROUTING_AUTH_FAILURE_MAX_COOLDOWN_MS` (default `14400000`, `0` refused at boot): the ceiling on that doubling, so a revoked key is re-tested at most every four hours instead of every fifteen minutes forever.

## [2.14.0] — 2026-10-01

Driven by a read of the 2.13.1 production log and database. (#135)

### Fixed

- **The CLI's refresh-lock contention is no longer read as a dead credential.** `claude` 2.1.286 has three spellings of "another Claude Code process is refreshing the token"; one contains "could not be refreshed" and classified as auth → `needs_reauth`, parking a healthy subscription until a human reconnected it, and another fell through as "a reason this router does not recognize". All three are now `claude-sdk:credential-refresh-contended`, a retryable `503`. "OAuth refresh token is no longer valid" stays auth.
- **A body naming no model is an `invalid_request`, not a `translation_failed`.** Nothing was translated. An empty body now says so, and a `Content-Encoding` request body is refused before it is read with `415 unsupported_content_encoding` — the router routes on a byte sniff and will not decompress to do it. The `request failed` log line carries `content-type`, `content-encoding`, `content-length` and `user-agent`. **`router_requests_total` counts these refusals under `outcome="client_error"`, no longer `translation_failed`** — re-key any alert on the old label.
- **The idle keepalive says why it failed.** A spent subscription window is `info`, not a reasonless `warn`, and the usage gauge is still read when the turn left the credential warm.
- **A model listing that always fails no longer holds the head of the refresh batch**, and the log carries the reason. An endpoint with no `/models` (404/405) is a skip.
- `claude-sonnet-5` priced at the published $2/$10 (was $3/$15).
- The shutdown test pins Bun 1.4's `stop(true)` contract. (#118)

### Added

- **Claude 5.5 family:** price and context-window rows for `claude-opus-5-5`, `claude-sonnet-5-5` and `claude-fable-5-1`; the `opus` and `sonnet` listing aliases follow the bundled CLI's catalog. The model a client sends is still never rewritten.
- `LOG_QUIET_PATHS` (default `/healthz,/readyz`): successful requests to these paths log at `debug`.

### Changed

- **Agent SDK 0.3.286 (bundled `claude` CLI 2.1.286).** Type surface additive only; the five-minute refresh lead and the `auth` command shapes re-verified against the new binary; the host-tool rejection gate untouched.
- **Bun 1.4.2** (image, CI, `engines`). hono 4.13, zod 4.6, vite 8, happy-dom 20, biome 2.5.15, drizzle-orm 0.45.3. The idle probe model is `claude-haiku-4-5-20251001`. `@hono/zod-validator` removed (unused).

## [2.13.1] — 2026-09-16

### Changed

- **Agent SDK 0.3.273 (bundled `claude` CLI 2.1.273).** Re-verified against the new binary before shipping: the CLI still refreshes an access token inside a five-minute lead (`Date.now() + 300000 >= expiresAt`), so the idle-query cold-margin floor from 2.13.0 still holds; `claude auth status` JSON and `claude auth login --claudeai` are unchanged. (#129)
- **README:** logo, social preview, and console screenshots from a demo database with fake data. (#130)

## [2.13.0] — 2026-09-07

### Fixed

- **A turn-free idle query no longer spends a subscription's refresh token — the actual cause of every deauthentication since 2026-09-06, on the third attempt.** The `claude` CLI refreshes an access token at startup whenever it is expired or inside its own five-minute lead, and persists the rotated refresh token only *after* the token endpoint has answered. The router's turn-free queries — the hourly model-catalog sweep and the usage gauge — wanted nothing but the `initialize` handshake, so they closed the query the moment it answered, and the SDK ended the subprocess before that write. The refresh token left on disk was now spent; the next process to present it — a client's turn, the keepalive, or the next probe — was told `invalid_grant`, and the CLI's dead-token handler blanked both tokens. Reconstructed on the 2.12.2 pod for every one of the six accounts lost between 2026-09-06 21:44 and 2026-09-07 12:10 UTC: `afbee92b` (the catalog probe crossed the CLI's lead at 08:11, the next probe at 09:21 blanked it, nothing else touched the directory in between), `27ae4129` (probe at 11:20, blanked by the next client turn at 11:44), and `426a1d04`, the busiest account in the pool at 615 requests a day (probe at 12:10:11, blanked by the next client turn **31 seconds later**). The two refreshes on the same pod that succeeded were both inside real turns, and both produced tokens that lived their full eight hours. `../claude-task-master` wraps the same SDK against the same subscriptions and has never lost one: it runs real turns only.

  2.11.0 read these losses as a double-spend race between two subprocesses; the concurrency data falsified that. 2.12.0 read them as an upstream invalidating idle tokens; the busiest account dying by the same sequence falsified that. `docs/idea/11-anthropic-agent-sdk.md` §3 keeps all three readings, with the timeline and the CLI code paths (`qO`, the `<CLAUDE_CONFIG_DIR>.lock` directory whose creation is visible as the *root's* mtime at each death, the CAS save, `R1e`).

  **The rule: a subprocess that will be ended early must never be the one that refreshes.** `CredentialFreshness.wouldRefresh` answers whether a spawn now would refresh an account's token — metadata, one boolean, nothing on the seam that could hold a token — and `openIdleQuery` asks it **before taking a slot and again after**, refusing with `IdleQueryColdCredentialError` rather than spawning. Inside `CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS` of the access token's expiry the model lister answers `{ kind: "cold" }` and the catalog refresh writes nothing (the previous rows stand, `agent-sdk:credential-cold`); the usage-gauge probe answers `"cold"` and the reading is not taken. Only a real turn — a process that runs to completion — may cross a refresh.

- **The keepalive is re-cut to what a turn can actually do, and runs *before* the gauge read.** A real turn refreshes only when the CLI would — inside that same five-minute lead — so 2.12.x's "warm anything expiring before the next sweep" spent turns that refreshed nothing: the 10:51 keepalive turns on `426a1d04` and `27ae4129` ran with 34 and 14 minutes of token life left, changed no file, and both accounts died on the next probe. `idle_account_probe` now uses the one definition of *cold* every spawn site shares, and the order per account is fixed: the free `claude auth status` check, then — if the token is cold — one small real turn, and **only then** the turn-free gauge read. A cold account that could not be warmed (keepalive off, no probe model, batch full, turn declined or failed) is not read at all and is named in the log. `CLAUDE_SDK_CREDENTIAL_KEEPALIVE=false` now means no probe ever spends a refresh token; the cost is staleness, never a login.

### Added

- `CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS` (default `600`): how close to its access-token expiry a credential counts as cold. **Floored at 300 — the CLI's own lead — and boot refuses anything narrower**, because a margin inside the CLI's window is this bug reinstated by configuration. `CLI_REFRESH_LEAD_MS` pins the CLI constant with its provenance.

### Removed

- `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_BEFORE_MINUTES`. Its premise — that a turn six hours before expiry refreshes anything — was false; the margin that matters is the CLI's, above. A value still set in an operator's environment is ignored.

## [2.12.2] — 2026-09-07

### Fixed

- **The router's own listener was cutting quiet streams.** `Bun.serve` ran with its default `idleTimeout` — 10 s of no bytes in either direction, swept every 4 s — which is shorter than the 15 s heartbeat a quiet SDK stream sends to stay open, so a turn whose tool-call arguments took longer than that to generate (held whole by the rewriter until the block closes, so the client saw nothing) died as `Failed to read … stream` on the client before its first keep-alive went out. Measured on the fleet on 2026-09-07: every such failure on both boxes sat on that 4 s grid with a phase constant per router pod, and a `write_file` call carrying a 1200-word argument reproduced it on demand — start frame at +2.2 s, zero bytes for 11.8 s, socket closed at +14.0 s — while a 93 s text-only answer streamed untouched. `SERVER_IDLE_TIMEOUT_SECONDS` (default `60`, `0` disables, `255` is the ceiling) now sets the listener's clock, `config/listen.ts` is the one seam between `Env` and `Bun.serve`, and a test holds the default to at least two of each keep-alive cadence. (#125)

## [2.12.1] — 2026-09-06

### Fixed

- **The credential keepalive's margin has to span a gap between sweeps, or it never fires.** 2.12.0 shipped a flat 60-minute margin against a 6-hour sweep, which leaves a hole the keepalive can never cover: a token expiring *after* this tick's margin but *before* the next tick is one no sweep sees in time. Against the live pool that was not hypothetical — account `426a1d04` expires at 19:20 with a sweep at 16:31, so it sat 2 h 49 m out (skipped now) and would have been dead by the next tick at ~22:31. The feature was inert for exactly the accounts it exists to protect.

  `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_BEFORE_MINUTES` now defaults to one `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES` plus 30 minutes of slack, **derived rather than fixed**, so retuning either keeps them consistent. An explicit setting still wins.

### Field note

The 2.12.0 rollout confirmed the corrected diagnosis prospectively. `idle_account_probe` ran **8 seconds after boot** — it had previously never run at all — and immediately parked `27ae4129`, the account flagged in advance as next to die: idle, access token expired at 11:20, credential blanked at **15:43:13** (509 B → 281 B, both tokens zeroed), with a single process and no concurrency anywhere near it.

## [2.12.0] — 2026-09-06

### Fixed

- **A subscription's credential is kept warm, and the sweep that watches it now survives a restart — the actual cause of the 2026-09-06 deauthentications.** 2.11.0 attributed those three losses to two subprocesses double-spending a rotating refresh token. Reconstructing every request interval from the production log (start = timestamp − `durationMs`, 730 inference requests over ten hours) does not support that: **peak concurrency all day was 2**, at `f97f6dd2`'s blanking **zero** data-plane requests overlapped, and at `a8c0fd1f`'s there was **exactly one** — the request that got the 401. One process on the directory; a double-spend needs two.

  The surviving pattern is the opposite of a race. The accounts doing the work lived (`426a1d04` 12 turns, `df3a4fd0` 2) and the ones nothing routed to died (`a8c0fd1f`, `f97f6dd2`, `afbee92b`, zero each) — which matches Meridian's field note that Anthropic invalidates refresh tokens left unused, and whose remedy is to keep the chain exercised.

  **And only a real turn exercises it.** The turn-free handshake behind the model-catalog sweep and the usage gauge does not rewrite `.credentials.json`: account `27ae4129` sat with an access token three hours expired through three consecutive hourly catalog probes with the file untouched. So the probe that looks like it exercises every account exercises no credential at all, and an unused account goes cold and stays cold until something finally tries to use it.

  `idle_account_probe` now reads each logged-in subscription's **access**-token expiry — metadata, one instant, from a type with no field that could hold a token — and gives any account inside `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_BEFORE_MINUTES` of expiry one small turn to refresh it. This spends a little usage by design; the previous reasoning refused a keepalive because it "cannot move a subscription's refresh-token cliff", which is true of the 30-day *login* cliff and irrelevant here — these tokens were rejected a month before it.

- **A long-interval scheduled task no longer skips itself forever on a restarting pod.** The first gap after boot was measured from process start rather than from the task's last recorded run, so a 24-hour sweep on a container that restarts more often than daily is armed, reported as scheduled, and never fires. `idle_account_probe` had run **zero** times in a ten-hour-old pod, which is exactly why the sweep that exists to notice a dying credential noticed nothing. `ScheduledTaskRun` recorded every run all along; the scheduler simply never read what it wrote. This fixes every long-interval task, not just this one.

### Changed

- `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES` defaults to **360**, down from `1440`. A subscription's access token lives ~8 h, so a daily sweep wakes long after a credential has gone cold and cannot keep one warm however well it works.

### Added

- `CLAUDE_SDK_CREDENTIAL_KEEPALIVE` (default `true`) and `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_BEFORE_MINUTES` (default `60`). With the keepalive off, a cold credential is logged rather than warmed, so the visibility survives either way.

### Documentation

- **`docs/idea/11-anthropic-agent-sdk.md` §3 carried the wrong root cause and is corrected in place**, with the concurrency numbers that falsified it, rather than quietly amended. 2.11.0's refresh-window guard stays — it closes a real hazard the spec had wrongly denied — it just was not what killed these three, and the section now says so at the confidence the evidence carries.

## [2.11.0] — 2026-09-06

### Fixed

- **One `claude` subprocess at a time across an Account's token refresh — the race that deauthenticated half the pool.** Anthropic's OAuth refresh token *rotates* when it is spent, so two subprocesses sharing one `CLAUDE_CONFIG_DIR` across the ~8-hourly refresh instant both present the stored value; the server honours the first and rejects the second, and the losing CLI reads that rejection as a dead login and blanks `.credentials.json` — destroying the winner's freshly rotated credential along with it. On 2026-09-06 that took out three of six production Accounts in nine hours, every one of them with a **month** left on `refreshTokenExpiresAt`: the login was alive, the token string was merely spent. Recovery is an interactive re-login, so this is now prevented rather than detected.

  `providers/claude-sdk/credential-freshness.ts` is the guard. Inside `CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS` of the access token's expiry exactly one subprocess per Account may cross: the first caller is not delayed at all and refreshes as part of whatever it came to do, and the rest wait until the credential file shows the new token, capped by `CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS` and then let through regardless. No extra subprocess is ever spawned to force a refresh, and the gate always fails open — an Account wedged behind it would be a worse outage than the race. Outside the window it is one ~500-byte read and nothing else.

  It sits *beside* the concurrency semaphore rather than inside it, because that gate bounds memory and only the `query()` paths hold it, while `claude auth status` and the login CLI spawn against the same directory through a raw `Bun.spawn`. Every spawn site takes freshness first and a slot second — one fixed order, so the two cannot deadlock. `CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT` is deliberately untouched: it is throughput the pool is sized on, and it was never what kept a credential safe.

  The router still reads **metadata, never a token** — two instants and a boolean out of a type with no field that could hold one. The Agent SDK continues to own the credentials and to perform every refresh itself; the gate decides only who waits.

- **The audit reason on a parked credential no longer claims the refresh token expired.** From the router's side a rejected refresh and an expired one look identical, and this incident was the former — three Accounts blanked with a month of refresh-token life left. It now says what is actually known: the CLI has blanked the tokens and the Account needs an interactive re-login.

### Added

- `CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS` (default `300`), `CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS` (default `20000`) and `CLAUDE_SDK_CREDENTIAL_REFRESH_POLL_MS` (default `250`). `0` on the skew is legal and means *no lead time* — the window still guards, but only once the token has actually expired.
- `CredentialMetadata.accessTokenExpiresAt`, the access token's own (~8 h) clock, distinct from the `refreshTokenExpiresAt` login clock that was already read. Presence-only on the tokens is unchanged, and the exhaustive key-list assertion that keeps a token from ever riding along now names it.

### Documentation

- **`docs/idea/11-anthropic-agent-sdk.md` §3 recorded the opposite of what happens, and is corrected with the evidence.** It — and the docstring in `concurrency.ts` — had this down as a considered deferral, reasoning that the CLI "carries its own cross-process locking" and that a lost race "fails one request into the ordinary auth classification rather than corrupting the file". Both halves were wrong. The section now carries the file sizes, the timestamps, the mechanism, and the corroborating observation from Meridian's `tokenRefresh.ts` that the refresh token is rotated on every refresh.
- `claude auth status` is documented as deliberately still unguarded, with the reason (its contract says it contacts nobody, and it had not run at all in the window containing the three deaths) and the seam to use if evidence ever contradicts that.

## [2.10.8] — 2026-09-06

### Added

- **The truncation alarm says what the flush closed.** A `tool_use` truncation on 2.10.7 arrived with `lastMessage: "user"` rather than the `"assistant"` that drove the 2.10.7 fix, and could not be reproduced: a stream that ends after a `user` message, one that throws after the block opened, and one that throws immediately all close their blocks correctly, and each is now a test. `flushedBlocks` is the fact that separates them from production — non-zero means the rewriter held that block and closed it, so whatever the renderer still had open was never the rewriter's to close and the discrepancy is between the envelope and the stream; zero means the rewriter was holding nothing at all.

### Documentation

- **Whether a truncated turn can be failed over is answered, and it is a fact about the shape rather than a policy.** A block can only be *open* if its `content_block_start` was forwarded, and on the streaming path a forwarded frame is a written byte — so by the time a turn can be called truncated, the client already holds part of it and "never retry after bytes are on the wire" applies with nothing left to decide. The non-streaming path answers the same question the other way for the same reason: nothing is written until the whole object is, so a truncated fold is still free to be a real status, and it is — which is what already lets the chain try another account there. Two paths, one rule, opposite outcomes, now pinned by tests. The streaming half of that failover was built and then deleted: `primed.done` together with a truncation is unreachable, because opening the block is itself the frame that makes it reachable, and a rule that never fires is one this repo says does not exist.

## [2.10.7] — 2026-09-06

### Fixed

- **A flushed tool-block close was not a `stream_event`, so the renderer never read it.** The enriched alarm answered its question on the first occurrence — `blocks: 1, kinds: ["tool_use"], lastMessage: "assistant", declaredTools: 12, passthrough: true` — putting this squarely in the branch where `ToolRewriter.flush` exists and ran, and still did not close the block. It ran correctly and produced exactly the right events; the last inch undid them. The renderer discriminates on the SDK message's `type`, and the flush added in 2.10.2 reused the filter's `rewrap` helper with whatever message the loop happened to end on. `rewrap` spreads that message and replaces its `event` field — right for every call inside `step()`, where the message *is* the `stream_event` under edit, and wrong at the flush, where the loop's last message is routinely an `assistant` one. The flushed `content_block_stop` then arrived typed `assistant` with a wire event stapled to it, the renderer never looked inside, the block stayed open, and the turn was answered as truncated: exactly as if the flush had never run. Flushed events are now built explicitly as `{ type: "stream_event", event, parent_tool_use_id: null }` — the null parent a fact rather than a default, since the rewriter only ever holds blocks from the turn the client asked for.

  `lastMessage: "assistant"` was in every one of these lines all along; it took the `declaredTools` and `passthrough` fields added in 2.10.6 to know which half of the tree to read it in.

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

[2.13.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.13.0
[2.13.1]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.13.1
[2.12.2]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.12.2
[1.0.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v1.0.0
[2.25.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.0
[2.25.1]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.1
[2.25.2]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.2
[2.25.3]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.3
[2.25.4]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.4
[2.25.5]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.5
[2.25.6]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.6
[2.25.7]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.7
[2.25.8]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.25.8
[2.26.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.26.0
[2.26.1]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.26.1
[2.27.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.27.0
[2.28.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.28.0
[2.28.1]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.28.1
[2.29.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.29.0
[2.30.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.30.0
[2.30.1]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.30.1
[2.31.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.31.0
[2.32.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.32.0
[2.33.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.33.0
[2.34.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.34.0
[2.35.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.35.0
[2.36.0]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.36.0
[2.37.5]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.37.5
[2.37.6]: https://github.com/developerz-ai/multi-ai-router/releases/tag/v2.37.6
