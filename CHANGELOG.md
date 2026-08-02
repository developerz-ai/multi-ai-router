# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
