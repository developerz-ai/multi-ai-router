# Deployment and Ops

Status: the compose file, the image, boot-time migrations, and the full environment reference below
are **implemented and shipped**. The janitor and every other periodic task (usage rollup, OAuth-state
purge, quota floor) are also shipped — in-process jittered timers, one `pg_try_advisory_lock` per
task, last run and outcome recorded to `ScheduledTaskRun` — and the retention windows below are what
they sweep against.

## The promise

**`docker compose up -d` after one sign-in method and one secret file edit.** No database to provision — and no IdP required either, if a local admin password suits the machine.

`docker compose up -d` brings up **two services**: the router and a PostgreSQL 16 container, with a
named volume for the Postgres data directory and a health check gating the router's start. The
compose file supplies `DATABASE_URL` itself. The operator fills `ENCRYPTION_KEY` in `.env` and picks
a sign-in method: the `ADMIN_OIDC_*` relying-party settings, or one
`docker compose exec router bun run dist/api/admin.js set-password` run after the stack is up (the
local password lives as an argon2id hash in Postgres, never in `.env`). See
[13-admin-oidc.md](13-admin-oidc.md) for both.

```yaml
# docker-compose.yml — abridged; the shipped file carries the full comments
services:
  router:
    image: ghcr.io/developerz-ai/multi-ai-router:latest
    ports: ["8080:8080"]
    env_file: [.env]                 # OIDC settings + ENCRYPTION_KEY
    environment:
      DATABASE_URL: postgres://router:router@postgres:5432/router
    depends_on:
      postgres: { condition: service_healthy }
    volumes:
      - claude-config:/data/claude   # per-Account CLAUDE_CONFIG_DIR — secret material
    restart: unless-stopped

  postgres:
    image: postgres:16
    environment: { POSTGRES_USER: router, POSTGRES_PASSWORD: router, POSTGRES_DB: router }
    volumes: [postgres-data:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U router -d router"]
    restart: unless-stopped

volumes:
  postgres-data:
  claude-config:
```

```bash
cp .env.example .env      # set ADMIN_OIDC_* and ENCRYPTION_KEY
# Register ADMIN_OIDC_REDIRECT_URI at the IdP, then:
docker compose up -d
```

The bundled Postgres publishes no host port: it is reachable from the compose network and nowhere
else, which is why the in-file credentials are acceptable. Publish it and you must change them.

The repo ships a working [`docker-compose.yml`](../../docker-compose.yml) and
[`.env.example`](../../.env.example) matching the table below exactly.

### Using an existing or managed Postgres

A one-line change. Replace the `DATABASE_URL` line in the `router` service with your own
connection string:

```yaml
DATABASE_URL: postgres://user:pass@db.internal:5432/router?sslmode=require
```

…then delete the bundled `postgres` service, the `depends_on` block, and the `postgres-data` volume.
Nothing else in the deployment changes: the router needs a reachable PostgreSQL 16+ and a role that
may create and alter tables in its schema (migrations run at boot). The `claude-config` volume stays
either way — it is unrelated to the database.

### Migrations

Migrations run **at boot, before the listener opens**, and are **idempotent** — a restart, a crash
mid-upgrade, or two containers racing the same database converge on the same schema.

A failed migration **fails the boot, loudly**: the process exits non-zero naming the migration that
failed, and never serves traffic on a half-migrated schema. `docker compose up -d` leaves you with a
restarting container and the reason in `docker compose logs router`, which is the correct outcome —
a router answering requests against a schema it does not understand is worse than one that is down.

## Environment reference

Env is validated by **Zod at boot**. A missing or malformed value exits **non-zero** with a message
naming the offending variable — the process never starts half-configured.

**Zero is not a way to turn something off.** On a numeric knob it is usually a sweep that deletes
the table it was pointed at, an interval that re-arms every millisecond, a cache that answers
nothing, or a breaker that never holds — none of which log anything, none of which stop traffic,
and all of which show up only as an absence somebody eventually notices. So every numeric variable
here **refuses `0` at boot** unless the row below says otherwise; the handful where zero is a real
setting say what it means. That split is enforced, not documented: a drift guard walks the schema
and fails the build for any numeric knob that is neither refused nor explained
(`apps/api/src/config/fields.ts`).

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_OIDC_ISSUER_URL` | for OIDC | — | Exact OIDC issuer. Discovery is fetched from `/.well-known/openid-configuration`; its `issuer` must match. |
| `ADMIN_OIDC_CLIENT_ID` | for OIDC | — | OIDC client identifier and expected ID-token audience. |
| `ADMIN_OIDC_CLIENT_SECRET` | no | — | Confidential-client secret. Omit only for a public client; PKCE S256 is always required. |
| `ADMIN_OIDC_REDIRECT_URI` | for OIDC | — | Exact callback URI registered at the IdP: `https://router.example.com/api/admin/auth/oidc/callback`. |
| `ADMIN_OIDC_ADMIN_EMAIL` | for OIDC | — | Comma-separated emails allowed to sign in. The ID token must carry one of them with `email_verified: true`. Several entries admit several humans to the one admin principal; they do not create users or roles. |
| `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | no | `false` | Opts out of the fail-closed rule that refuses boot while a local admin password exists and `PUBLIC_URL` is not loopback — see [13-admin-oidc.md](13-admin-oidc.md). Boot warns on every start while it is on. |
| `ADMIN_OIDC_ADMIN_SUBJECT` | no | — | Optional stricter exact match against the ID token's `sub`. Recommended once known. |
| `ADMIN_OIDC_SCOPES` | no | `openid profile email` | Space-separated scopes sent to the IdP. Must include `openid`. The IdP must embed `email` and `email_verified` in the ID token. |
| `ADMIN_OIDC_CLOCK_SKEW_SECONDS` | no | `60` | Clock-skew tolerance for token timestamps. **`0` refused at boot**: no real hosts have perfectly synchronized clocks. |
| `ENCRYPTION_KEY` | yes | — | 32 bytes, base64. AES-256-GCM key for upstream credentials and router keys. Boot fails loudly if missing or short. |
| `DATABASE_URL` | yes | — | PostgreSQL 16+ connection string. **Supplied by the bundled compose file**, so it is not one of the three you set by hand. Set it yourself only when pointing at an existing/managed instance. |
| `DB_POOL_MAX` | no | `10` | Connections this replica holds open. **One pool serves everything that is not the request path** — the admin console, every scheduler sweep, the off-path usage/quota/status writers and `/readyz` — so it is the ceiling on all of them at once, and a long sweep holding a connection is one fewer for the console. Raise it for a busy console or long sweeps; lower it when several replicas share a managed instance with its own connection cap (`max_connections`), remembering each replica opens its own pool. **`0` refused at boot**: it opens nothing and queues every query forever. |
| `DB_POOL_IDLE_TIMEOUT_SECONDS` | no | `30` | How long an idle pooled connection is kept before it is closed. `0` is legal and means *never* close one — postgres.js reads a falsy interval as a timer that never fires, not as "immediately". |
| `DB_POOL_CONNECT_TIMEOUT_SECONDS` | no | `10` | How long a dial waits to be accepted before it fails. Raise it for a managed instance that is slow to accept; the boot migration uses the same value, so a raise covers the connection that runs before the pool exists. **`0` refused at boot**: by the rule above it would mean *wait forever*, turning an unreachable database from a failure into a hang. |
| `DB_POOL_MAX_LIFETIME_SECONDS` | no | `1800` | Age at which a pooled connection is recycled, so a failover behind a connection proxy drains onto the new primary instead of pinning to the old one. `0` is legal and never recycles. |
| `DB_POOL_CLOSE_TIMEOUT_SECONDS` | no | `5` | How long the shutdown's pool close waits for in-flight queries before destroying them — see [Shutdown & draining](#shutdown--draining). It runs after the flush, so an unbounded wait here buys nothing and risks the `SIGKILL`. `0` is legal and destroys the pool at once. |
| `PORT` | no | `8080` | Listen port inside the container. `0` is legal and lets the kernel pick an ephemeral port; the boot log names the one it bound. |
| `SERVER_IDLE_TIMEOUT_SECONDS` | no | `60` | How long a connection may carry no bytes in either direction before the **server** closes it (`Bun.serve`'s `idleTimeout`). Unset, Bun applies 10 s on a 4 s sweep — shorter than the 15 s heartbeat a quiet SDK stream sends to stay open, so a turn whose tool arguments took longer than that to generate (held whole by the rewriter, so the client received nothing until the block closed) was cut mid-turn and read as `Failed to read … stream` on the client; measured on the fleet 2026-09-07, every such failure sat on the 4 s grid. Keep it comfortably above the heartbeat — a test holds the default to at least two of them. `255` is the ceiling (one byte); `0` is legal and disables the server's clock, leaving the client heartbeat and the upstream idle guard as the only clocks on a stream. |
| `SHUTDOWN_READY_GRACE_MS` | no | `0` | How long the router keeps serving after `/readyz` starts answering `503 shutting_down` and before the listener closes — the window a load balancer has to notice. `0` skips it, which is right under the bundled compose file (nothing there polls readiness). On Kubernetes set about two readiness periods (`periodSeconds` default `10s` → `20000`). `0` is legal and means close the listener at once. |
| `SHUTDOWN_DRAIN_MS` | no | `15000` | How long a shutdown lets in-flight responses finish before it stops waiting. This plus `SHUTDOWN_READY_GRACE_MS` plus `DB_POOL_CLOSE_TIMEOUT_SECONDS` must stay **under** whatever grace the orchestrator gives the container (`stop_grace_period`, `terminationGracePeriodSeconds`) — see [Shutdown & draining](#shutdown--draining). `0` waits for nothing. |
| `CLAUDE_CONFIG_ROOT` | no | `/data/claude` | Parent directory holding one `CLAUDE_CONFIG_DIR` per Claude subscription Account. Must sit on the persistent `claude-config` volume. Secret material — see [Persistence & backup](#persistence--backup). |
| `CLAUDE_CLI_PATH` | no | — | Pins the `claude` binary the Agent SDK spawns, bypassing resolution. Unset is right: the image stages one on `PATH` and `/readyz` reports which rung of the ladder won. A set-but-unusable path **fails** rather than falling back, so the router never spawns a binary you did not name — see [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md#9-operational-notes). |
| `CLAUDE_SDK_MAX_CONCURRENCY` | no | `10` | `claude` subprocesses in flight on this replica. Every subscription request spawns one (~245 MB native binary, measured — see [Sizing](#sizing)), so this is a **memory** bound, not a throughput one — size against RAM, not CPUs. Requests over the ceiling queue rather than fail. Bounds every spawner, including the console's **Test now** button. Watch `router_sdk_subprocesses` and `router_sdk_subprocess_queue_depth` to size it against real traffic. |
| `CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT` | no | `4` | The same ceiling for any one subscription Account — what stops one Account's burst starving the pool. Values above `CLAUDE_SDK_MAX_CONCURRENCY` are legal and simply never bind. |
| `CLAUDE_SDK_CREDENTIAL_KEEPALIVE` | no | `true` | Gives a logged-in subscription account whose **access** token is cold one small real turn **before** the sweep's turn-free gauge read touches its directory. A real turn runs to completion and so persists the rotated refresh token; a turn-free probe is ended before that write and spends the token for nothing ([11-anthropic-agent-sdk.md §3](11-anthropic-agent-sdk.md)). Costs one small turn per cold account per sweep, bounded by `IDLE_ACCOUNT_PROBE_BATCH_SIZE`. `false` warms nothing: a cold account keeps its old gauge and catalog until a client's turn refreshes it, and no probe ever spends its refresh token. |
| `CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS` | no | `600` | How close to its access-token expiry a subscription credential counts as **cold**: no turn-free `claude` subprocess is spawned against it, and the keepalive spends a real turn on it instead. The `claude` CLI refreshes within **five minutes** of expiry on its own and persists the rotated refresh token only after the token endpoint answers, so a turn-free subprocess spawned inside that lead is ended before the write — the mechanism that deauthenticated six of six accounts on 2026-09-06/07. **At least `300`, the CLI's own lead: boot refuses anything narrower.** The default doubles it so a probe that queued behind live traffic still cannot arrive inside the CLI's window. |
| `CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS` | no | `300` | How near an access token's expiry counts as the refresh window, inside which only one **real turn** per Account may run at a time — the refresh token rotates when spent, and two live subprocesses asking the token endpoint together would double-spend it ([11-anthropic-agent-sdk.md §3](11-anthropic-agent-sdk.md)). The first caller is never delayed; outside the window this costs one read. Turn-free probes never enter the window: they are refused at `CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS`. `0` is legal and means *no lead time*. |
| `CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS` | no | `20000` | How long a waiter gives the Account's refresher before proceeding regardless. The gate always fails open — an Account wedged behind it would be worse than the race — and warns when it does. **`0` refused at boot.** |
| `CLAUDE_SDK_CREDENTIAL_REFRESH_POLL_MS` | no | `250` | How often a waiter re-reads the credential file. **`0` refused at boot.** |
| `CLAUDE_SDK_USAGE_GAUGE` | no | `true` | Reads a Claude subscription's plan-usage percentages (`five_hour`, `seven_day`, per-model) through the Agent SDK's own query object once a turn has started answering, and once per account on the daily sweep through a turn-free query. Never on the response path, never a turn of its own, never a token touched — see [11-anthropic-agent-sdk.md §5](11-anthropic-agent-sdk.md#5-quota-and-rate-limit-signals). `false` leaves the console showing only the threshold alarms. |
| `CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS` | no | `5000` | The most one gauge reading may take before it is dropped. A dropped reading costs nothing but freshness. **`0` refused at boot.** |
| `CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS` | no | `60` | At most one gauge reading per account per interval, counted from when a reading started, so a burst of parallel coding agents on one subscription asks the usage endpoint once. `0` asks on every turn. |
| `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | no | `60` | Minimum interval between manual **Re-check now** probes of the same account. The button re-queries the provider's live quota signal; this is what stops it being used to hammer an upstream. `0` is legal and means no cooldown. |
| `ACCOUNT_TEST_NOW_COOLDOWN_SECONDS` | no | `120` | Minimum interval between manual **Test now** presses of the same account. Distinct from the re-check cooldown above and deliberately longer: this button sends one real, billed completion, and on a Claude subscription it spawns a `claude` subprocess and spends a turn. `0` is legal and means no cooldown. |
| `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS` | no | `60` | How long the admin accounts read trusts one reading of a Claude subscription's credential *metadata* — login expiry, plan, tier; never the token — before re-reading `.credentials.json`. What keeps a console poll from stat-ing six files a second. `0` re-reads on every accounts read. |
| `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES` | no | `360` | How often the credential sweep runs. **6 h, not 24, since 2.12.0**: a subscription's access token lives ~8 h, so a daily sweep wakes long after a credential has gone cold and cannot keep one warm however well it works. The sweep's first tick after a restart is measured from its **last recorded run**, not from process start — a 24 h task on a pod that restarts more often than daily never ran at all. **The billed *idle* half's per-account cadence is set by `IDLE_ACCOUNT_AFTER_DAYS`, not by this**: testing an account counts as using it, so each one is touched about once per idle window rather than once per tick. **`0` refused at boot**: it re-arms every millisecond. |
| `IDLE_ACCOUNT_AFTER_DAYS` | no | `7` | How long an account must go unused before one real, **billed** request is spent on it. What that buys, precisely: the Agent SDK refreshes a Claude subscription's *access* token only when it runs, so an account nobody routes to fails its first request after a long silence with a stale access token — one real request keeps that warm. What it does **not** buy: a subscription's *refresh* token hard-expires ~30 days after login however much it is used (verified in production), and no request, probe, or timer can move that date — only reconnecting from `/accounts` can. The same daily tick also runs the free `claude auth status` check over **every** subscription account, idle or not, so an expired one reads `needs_reauth` within a day. **`0` refused at boot**: every account would be idle, so every account would be billed every tick. |
| `IDLE_ACCOUNT_PROBE_BATCH_SIZE` | no | `5` | Accounts probed per tick. Deliberately separate from `SWEEP_BATCH_SIZE` and much smaller: each item may spawn a ~245 MB `claude` subprocess and bill a turn, which is nothing like deleting a row. The sweep is resumable, so a backlog drains over consecutive ticks. **`0` refused at boot**. |
| `IDLE_ACCOUNT_PROBE_PAID_TURN` | no | `false` | Whether the sweep may spend a real, **billed** turn on an idle account at all. **Off by default — checking whether a subscription is alive must never spend usage.** A turn refreshes only the *access* token; the 30-day refresh-token cliff is unaffected, so the operator was paying for a check that could not achieve its aim. With it off, the daily free `claude auth status` check still runs over every subscription and the turn-free usage gauge is read for each logged-in one. Set `true` only if you want idle HTTP OAuth accounts kept warm at the cost of a request each per idle window. |
| `MODEL_CATALOG_REFRESH_INTERVAL_MINUTES` | no | `60` | How often each account's upstream is asked what models it serves, and how big they are — the data behind `GET /v1/catalog`. **Free**, unlike the keepalive above: a model listing costs no tokens and spends no quota window, which is what lets it run hourly. It writes only the catalog table; `supported_models` — the column that decides which accounts a request may land on — stays operator-owned and is never touched by this timer, so an upstream retiring a model changes what the listing *says* and never where a request goes. Skipped for Claude subscriptions (no listing endpoint), for `openrouter` (an aggregator of models it does not itself serve), and for accounts you disabled. **`0` refused at boot**. |
| `MODEL_CATALOG_REFRESH_BATCH_SIZE` | no | `25` | Accounts refreshed per tick, **oldest catalog first**. The ordering is what makes this a rate limit rather than a horizon: a fixed "first N" would refresh the same accounts every hour and never reach the rest. A fleet larger than one batch rotates across consecutive ticks. **`0` refused at boot**. |
| `PUBLIC_URL` | no | — | Externally reachable base URL. Only used to build the OAuth redirect-capture callback (`PUBLIC_URL + /admin/accounts/oauth/callback`). Unset → paste-back capture only. |
| `WEB_ROOT` | no | `dist/web` beside the bundled entrypoint | Directory holding the built admin console, which the router serves at `/` on its own origin. The default is correct in the image; set it only when the assets live elsewhere. Set-but-missing an `index.html` **fails boot** rather than quietly serving an API-only router that looks like a broken web app. Absent assets at the default path are not fatal — that is what running from source looks like, and Vite serves the console itself in dev. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. Structured JSON either way. |
| `LOG_REASON_MAX_CHARS` | no | `200` | Ceiling on how much of a described error — the full cause chain, innermost first — one log line quotes as its `reason`, including the upstream's own text on the `upstream attempt failed` line. A driver names the statement it refused, and a batched statement is thousands of bind parameters long; unbounded, the one line an operator needs becomes the reason they cannot read any of them. |
| `METRICS_TOKEN` | no | — | Bearer token `GET /metrics` demands (`Authorization: Bearer …`). Unset leaves the endpoint open, which is right only where its port is not routable from outside the host. The exposition carries account, key and pool ids — never a credential. |
| `ADMIN_API_TOKEN` | no | — | Bearer token that authenticates `/api/admin/**` **without a browser login** — the credential a deploy script, a CI job, or an agent uses to drive the same REST API the console drives ([04-api-keys-and-access.md](04-api-keys-and-access.md#driving-the-admin-api-without-a-browser)). Unset leaves the admin plane browser-only, which is the default. **Boot refuses a token under 32 characters** — unlike OIDC start/callback, this static bearer is not throttled, so length is what bounds a guessing attack — and refuses one beginning `mar_live_`, since the admin guard rejects that prefix outright and such a token would authenticate nothing while reading as correct. Rotate by changing the value and restarting; there is no revoke call, because there is no session to end. |
| `ROUTER_REVISION` | no | `unknown` | Which commit this build is, reported by `router_build_info{revision}` and the `router listening` boot log line. The published image bakes in the tagged commit's sha (`--build-arg ROUTER_REVISION=…`); a version alone cannot separate a rebuilt `latest` from the tag it was cut for. Set it by hand only when you build your own image. |
| `TRUST_PROXY` | no | `false` | Honor `X-Forwarded-For` / `-Proto`. Set `true` **only** behind a proxy you control — otherwise clients can forge their own IP past the rate limiter. |
| `RETENTION_SESSIONS_HOURS` | no | `24` | Idle sticky-session and fingerprint TTL. Retention is *keep for*, never *keep nothing*: at `0` the cutoff is the sweep's own clock, so the janitor empties the table on its next tick and every tick after. **Refused at boot.** |
| `RETENTION_USAGE_DAYS` | no | `90` | Raw `UsageRecord` retention before roll-up to daily aggregates. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `RETENTION_USAGE_DAILY_DAYS` | no | `730` | Daily aggregate (`usage_daily`) retention — the long half of usage retention, and one row per distinct (day, key, account, pool, model). **Must be ≥ `RETENTION_USAGE_DAYS`, refused at boot otherwise**: a shorter window has the janitor delete rolled days whose raw rows still exist, and the rollup writes them straight back on its next tick. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `RETENTION_AUDIT_DAYS` | no | `365` | `AuditEvent` retention. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `RETENTION_TASK_RUNS_DAYS` | no | `30` | How long a **finished** `ScheduledTaskRun` row is kept. Six tasks ticking as often as every five minutes write on the order of a thousand rows a day between them. A run with no `finishedAt` is never swept however old it is — that row is the only evidence a task wedged or a process died holding the lock. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `RETENTION_REVOKED_KEYS_DAYS` | no | `30` | How long a revoked/expired `ApiKey` row survives before purge. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `RETENTION_OAUTH_STATE_MINUTES` | no | `10` | TTL for one-shot OAuth `state` + PKCE verifiers. **`0` refused at boot**: it would expire a one-shot `state` at the instant it is minted, so no OAuth connect could ever complete. |
| `RETENTION_ORPHAN_CONFIG_DIR_HOURS` | no | `24` | Grace before a `CLAUDE_CONFIG_DIR` under `CLAUDE_CONFIG_ROOT` that no account claims is removed. A directory is provisioned just *before* its account row is inserted, so this must comfortably exceed that gap — too short and the reaper deletes a login still being made. **`0` refused at boot**: a grace of nothing deletes the login being made right now. |
| `RETENTION_SDK_TRANSCRIPT_HOURS` | no | `24` | How long an Agent-SDK session transcript — the `<session>.jsonl` (and `<session>/` directory) the `claude` CLI writes under an Account's `CLAUDE_CONFIG_DIR` for `--resume` — is kept after its last turn, measured by the file's own mtime. Defaults to the same day as `RETENTION_SESSIONS_HOURS`, so the row that could resume a transcript and the file it would resume expire together. Shorter trades disk for a cold replay on the next turn of a paused conversation; it never costs a request — a resume onto a swept transcript is a `stale-session`, replayed in place. **`0` refused at boot** — see `RETENTION_SESSIONS_HOURS`. |
| `JANITOR_INTERVAL_MINUTES` | no | `60` | Base sweep interval; the janitor jitters around it. **`0` refused at boot** — every interval below re-arms at 1 ms and becomes a busy loop against Postgres. |
| `USAGE_ROLLUP_INTERVAL_MINUTES` | no | `60` | Usage record rollup interval, in minutes. Raw records older than `RETENTION_USAGE_DAYS` are summarized into daily aggregates. **`0` refused at boot.** |
| `OAUTH_STATE_PURGE_INTERVAL_MINUTES` | no | `5` | OAuth state (and PKCE verifier) purge interval, in minutes. One-shot values older than `RETENTION_OAUTH_STATE_MINUTES` are deleted. **`0` refused at boot.** |
| `QUOTA_FLOOR_INTERVAL_MINUTES` | no | `30` | Account quota floor probe interval, in minutes. Periodic refresh of cached quota state. **`0` refused at boot.** |
| `CONFIG_DIR_REAP_INTERVAL_MINUTES` | no | `360` | How often the orphaned-`CLAUDE_CONFIG_DIR` reap runs. Hours rather than minutes: an orphan is a crash artifact. *How long* one may linger is `RETENTION_ORPHAN_CONFIG_DIR_HOURS`, not this. **`0` refused at boot.** |
| `SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES` | no | `60` | How often the Agent-SDK transcript sweep walks `CLAUDE_CONFIG_ROOT`. Hourly like the janitor: a transcript becomes removable at most once an hour, and a tick is a directory listing, not a subprocess. *How long* a transcript is kept is `RETENTION_SDK_TRANSCRIPT_HOURS`, not this. **`0` refused at boot.** |
| `ADMIN_SESSION_PURGE_INTERVAL_MINUTES` | no | `30` | How often expired rows are swept out of `admin_sessions` — a bounded-batch table sweep under the advisory lock like every other retention task, since sessions live in Postgres (`services/admin-auth/postgresSessionStore.ts`). An expired session is refused by `authenticate()` regardless; this frees the rows. **`0` refused at boot.** |
| `SWEEP_BATCH_SIZE` | no | `1000` | Max rows per bounded-delete sweep (usage, session, revoked keys, audit, OAuth state), directories per orphaned-config-dir reap, and sessions per Agent-SDK transcript sweep. Larger trades memory and latency for fewer sweeps; smaller means more passes. **`0` refused at boot**, and not because it would delete nothing: a drain learns a category is caught up from a batch shorter than the limit, and nothing is shorter than zero, so the tick spins forever holding its advisory lock. |
| `SCHEDULER_JITTER_FRACTION` | no | `0.2` | Jitter applied to task intervals as a fraction of the interval. E.g., `0.2` means ±20% around the base value, spreading load after a restart. |
| `OAUTH_REFRESH_LEAD_FRACTION` | no | `0.75` | Share of a router-held OAuth token's remaining lifetime allowed to elapse before it is refreshed — `0.75` refreshes with a quarter of the lifetime in hand. Not an interval: refresh is per account and expiry-driven, never a poll. Claude subscriptions are unaffected; the Agent SDK owns those tokens. |
| `OAUTH_REFRESH_MIN_DELAY_SECONDS` | no | `30` | Floor on any refresh delay, and the first step of the retry backoff. What stops an already-expired token from re-arming at zero and hammering the provider. |
| `OAUTH_REFRESH_MAX_ATTEMPTS` | no | `5` | Attempts against an unreachable token endpoint before the account is parked at `needs_reauth`. A *refused* refresh is never retried — only a clock fixes an outage. |
| `ADMIN_SESSION_IDLE_MINUTES` | no | `43200` | Sliding idle window, and the session cookie's `Max-Age`. Thirty days: a single-operator console behind SSO whose sessions survive a redeploy (they live in `admin_sessions`), so the operator is not asked to sign in weekly — the trade is written down in [13-admin-oidc.md](13-admin-oidc.md#session-and-callback-behavior). Raising it leaves an abandoned browser a live credential for longer. **`0` refused at boot**: it expires a session at the instant it is issued, so login answers `200` and everything after it answers `401`. |
| `ADMIN_SESSION_ABSOLUTE_HOURS` | no | `720` | Hard ceiling on a session's total life regardless of activity — thirty days, matching the idle window. A purely sliding session is one a thief renews forever; logout is a real row deletion, and a login mints a fresh id. **`0` refused at boot** — same failure as the idle window. |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | no | `5` | Failed logins per throttle key (per IP, per username) before it locks. **`0` refused at boot**: it locks a key on its zeroth failure, so nobody can log in at all. |
| `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES` | no | `15` | Failures older than this stop counting toward the lock. **`0` refused at boot**: a failure counted in a window of nothing means the throttle can never trip, and brute-force protection is off with no sign of it. |
| `ADMIN_LOGIN_LOCKOUT_MINUTES` | no | `15` | How long a tripped throttle key stays locked. **`0` refused at boot** — a lockout that has already elapsed is the same silent hole. |
| `ADMIN_SESSION_TOUCH_INTERVAL_SECONDS` | no | `60` | How long a session's idle-window slide may go unpersisted. The in-memory value is authoritative for every response regardless; this coalesces the `admin_sessions` write to one per interval per session instead of one per authenticated request. `0` persists every slide. |
| `ADMIN_SESSION_CACHE_MAX` | no | `1000` | Sessions the durable store keeps warm in memory per replica, so `authenticate()` reads Postgres once per session it has not seen, not once per request. The table is the truth; a restart only costs one read per live session. **`0` refused at boot.** |
| `SESSION_COOKIE_INSECURE` | no | `false` | Drops `Secure` and the `__Host-` prefix from the admin session cookie. The escape hatch for a **plain-HTTP install** (`http://192.168.1.50:8080` on a LAN), which is otherwise unusable: a browser silently discards a `Secure` cookie sent over `http://`, so login answers `200` and every request after it is `401`. `HttpOnly`, `SameSite=Strict` and the CSRF token are unaffected. What you give up is confidentiality on the wire and the `__Host-` guarantee that no sibling host under this domain can plant a session cookie — so unset it once HTTPS is in front. Leaving it unset on a plain-HTTP install is diagnosed for you: the login logs a `warn` naming this variable. Turning it on logs a `warn` on every boot while it is on. See [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie). |
| `CATALOG_REFRESH_SECONDS` | no | `30` | How long the warm routing catalog — and the operator's price overrides, which are the same kind of admin-edited configuration — may lag a write made by **another replica**. A write by this replica refreshes both immediately, so this bounds only the multi-replica case. **`0` refused at boot**: it puts the catalog query on a 1 ms loop, and the request path's budget forbids Postgres anywhere near it. |
| `KEY_CACHE_MAX` | no | `4096` | Verified router keys held in memory. The ceiling is memory, not correctness — an evicted key costs one indexed lookup. **`0` refused at boot**: a cache of no entries answers nothing and every request pays the lookup it exists to avoid. |
| `KEY_CACHE_TTL_SECONDS` | no | `60` | How long a successful verification is reused. Revocation invalidates immediately on the replica that served the admin request, so on a single-replica deployment this bounds staleness of a key's limits and scope, not of its revocation — on several replicas it bounds both, for every replica but that one. **`0` refused at boot** — entries expiring at the instant they are written is the same cache, differently disabled. |
| `KEY_CACHE_NEGATIVE_TTL_SECONDS` | no | `5` | How long a failed lookup is remembered. Short on purpose: it stops a flood of bad keys becoming a flood of queries, and a just-minted key must start working quickly. `0` is legal and means *do not cache a miss at all*. |
| `SESSION_CACHE_MAX` | no | `4096` | Session → Account bindings held in memory, plus their fingerprint aliases. Only Claude subscription accounts ever create one. **`0` refused at boot** — see `KEY_CACHE_MAX`. |
| `SESSION_CACHE_TTL_SECONDS` | no | `300` | How long a binding is reused before its row is re-read. Bounds only how long this replica may lag another one's rebind; the row itself never expires, because an SDK session outlives any cache. **`0` refused at boot** — see `KEY_CACHE_TTL_SECONDS`. |
| `SESSION_CACHE_NEGATIVE_TTL_SECONDS` | no | `30` | How long "this session has no binding" is remembered. Short, and for the opposite reason: it keeps plain HTTP traffic on a subscription-serving router from re-asking Postgres every request. `0` is legal and means *do not cache an absent binding at all*. |
| `USAGE_QUEUE_MAX` | no | `10000` | `UsageRecord` rows queued before the writer sheds the oldest. Overflow degrades reporting, never traffic. **`0` refused at boot**: a queue that holds nothing sheds every record on the way in. |
| `USAGE_BATCH_SIZE` | no | `200` | Rows per insert. Larger means fewer round trips and a bigger loss if the process dies mid-queue. **Bounded `1..2520`, refused at boot outside it**: a usage row spends 26 of the 65 535 bind parameters Postgres allows per statement (65 535 / 26 = 2520), and a batch past that is rejected on every flush — forever, with traffic unaffected and the usage table empty. |
| `ROUTING_MAX_ATTEMPTS` | no | *every eligible account* | Ceiling on the distinct accounts tried for one client request before the honest failure. Unset — the default — means the pool is the ceiling: the chain keeps walking while an untried candidate exists, which is what a deep pool is for. Set it only to fail *faster* than that; it can lower the bound, never raise it past the candidates that exist, and it never overrides the rule that an attempt is not retried once bytes are on the wire. **`0` refused at boot**, because it is silently clamped to `1` downstream — an operator who writes `0` meaning *do not retry* gets one attempt and no sign the number was ignored. |
| `ROUTING_FAILURE_THRESHOLD` | no | `3` | Consecutive 5xx or connection failures before an account's breaker trips. **`0` refused at boot**: a breaker that trips on the zeroth failure parks every account. |
| `ROUTING_BASE_BACKOFF_MS` | no | `1000` | First cooldown step; doubles per consecutive failure. **`0` refused at boot**: a cooldown of nothing lets a dead upstream be retried as fast as it can refuse. |
| `ROUTING_MAX_BACKOFF_MS` | no | `300000` | Ceiling on that doubling, so a long outage does not park an account for hours. **`0` refused at boot** — it clamps every step of the doubling to zero, which is the same hole. |
| `ROUTING_HALF_OPEN_HOLD_MS` | no | `30000` | How long the one request admitted onto a recovering account holds it. Everyone else gets `429` with this instant until the probe reports, so the backlog built up during a cooldown cannot stampede the account the moment it returns. Released on the probe's verdict, so this only governs a probe that never reports. |
| `ROUTING_BOUND_ACCOUNT_COOLING_DOWN` | no | `fail` | What a request does when its session is bound to an account that is merely cooling down. `fail` answers `429` with a `Retry-After` and keeps the binding — the conversation stays resumable on the account that owns it, which is the correct default because an SDK session id means nothing anywhere else. `rebind` drops the binding instead and starts a fresh upstream session on another eligible account: the request is served now rather than after the reset, at the cost of the prior turns the bound account still holds. Only worth setting for clients that resend their full history every turn and would rather lose upstream-side resumability than wait; with a single-account pool it changes nothing — there is nowhere to rebind to. Any value other than `fail` or `rebind` is refused at boot. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| `UPSTREAM_TIMEOUT_MS` | no | `600000` | How long the router waits on one upstream. Long, because a long completion is a normal response and not a hung one. **`0` refused at boot**: `AbortSignal.timeout(0)` fires before the socket does, aborting every upstream request. |
| `TRANSLATE_DEFAULT_MAX_TOKENS` | no | `4096` | The `max_tokens` an Anthropic account is given when the client spoke a dialect that makes it optional and sent none. Anthropic requires the field; the default is generous on purpose, because a low value truncates answers nobody asked to truncate. **`0` refused at boot**: Anthropic requires `max_tokens >= 1`, so zero turns every translated request that omitted it into a `400` that looks like a client bug. |
| `USAGE_FLUSH_INTERVAL_MS` | no | `1000` | Drain cadence. Raising it widens the window in which a crash loses unwritten usage rows; it never affects request latency. **`0` refused at boot**: `setInterval(…, 0)` is a busy loop flushing an empty queue. |
| `QUOTA_WRITE_INTERVAL_MS` | no | `5000` | How often quota readings observed on responses are persisted to `quota_windows`. Not a poll — a reading only exists once a response reported one. Raising it widens the window in which a crash loses the freshest reading, and how stale the gauges are on a replica that did not serve the request. Never affects request latency: the write is coalesced per account and never awaited by one. |
| `MAX_REQUEST_BODY_BYTES` | no | `33554432` (32 MiB) | The largest request body the router will read. Over it: `413` `request_too_large`, refused before any account is dialed. A declared `Content-Length` over the ceiling is turned away without reading a byte, so a hostile body never gets the ceiling's worth of buffering; a body that lies about its length is still caught as it streams. Raise it for agents that paste whole repositories into a prompt, lower it to bound what one in-flight request can cost in memory. |
| `ACCOUNT_STATUS_WRITE_INTERVAL_MS` | no | `1000` | How often a standing block the breaker just formed — `exhausted`, `needs_reauth` — is written through to `accounts.status`. Not a poll, and not a cooldown: a cooldown is clock-recoverable and deliberately stays in memory. Shorter than the quota interval because what it bounds is worse — a lost reading costs a stale gauge, a lost block costs the operator the banner telling them an account needs topping up. Routing is unaffected at any setting; the breaker holds the verdict either way. |

The last two groups are the request path's own tunables: nothing there queries Postgres, so those
values are what decide how quickly it learns about a change and how much memory it spends not
having to. Defaults mirror the layer constants they override, so an unset variable and a variable
set to its default behave identically.

Generate an encryption key with `openssl rand -base64 32`. Losing it loses every stored credential —
there is no recovery path. See [07-security.md](07-security.md).

## Cleanups & retention

One background janitor service, one schedule, every window env-tunable.

| What | Default retention | Env var | Why |
|---|---|---|---|
| Idle sessions (sticky map + fingerprints) | 24 h since last use | `RETENTION_SESSIONS_HOURS` | Unbounded growth otherwise; Claude-Code-style long-lived sessions must expire. |
| In-memory LRU caches (session, fingerprint, health) | bounded size, coordinated eviction | — | A fingerprint entry must die with its session. |
| Usage records | 90 days raw → rolled up to daily aggregates | `RETENTION_USAGE_DAYS` | Keeps the dashboard fast and the DB small. |
| Daily usage aggregates | 730 days | `RETENTION_USAGE_DAILY_DAYS` | Outliving the raw rows is the point of the rollup; outliving them *forever* is not. Must never be shorter than the raw window — boot refuses it, because the janitor and the rollup would otherwise delete and re-insert the same days on every tick. |
| Audit events | 365 days | `RETENTION_AUDIT_DAYS` | Compliance-ish; never contains secrets. |
| Scheduled task runs | 30 days, finished runs only | `RETENTION_TASK_RUNS_DAYS` | ~1000 rows/day across six tasks. An **unfinished** run is never swept: it is the only evidence a task wedged or a process died mid-sweep. |
| Expired/consumed OAuth state & PKCE verifiers | 10 min | `RETENTION_OAUTH_STATE_MINUTES` | One-shot values. |
| Revoked / expired API keys | 30 days after revocation, then purged | `RETENTION_REVOKED_KEYS_DAYS` | Keeps historical usage joinable for a while. |
| Rate-limit & circuit-breaker state | expires with its reset window | — | Derived state, not durable state. |
| Orphaned `CLAUDE_CONFIG_DIR`s on the volume | 24 h unclaimed | `RETENTION_ORPHAN_CONFIG_DIR_HOURS` | **Not a disk-space sweep.** Each holds a subscription's OAuth credentials in cleartext; one whose account no longer exists is a credential nothing will ever rotate or revoke. Only names that are account ids are candidates, and only past the grace — the directory is created *before* its row, so a young one may be a login still being made. |
| Agent-SDK session transcripts on the volume | 24 h since the transcript's last turn | `RETENTION_SDK_TRANSCRIPT_HOURS` | The `claude` CLI writes `projects/<cwd>/<session>.jsonl` (+ `<session>/`) per SDK session under each Account's `CLAUDE_CONFIG_DIR` and never removes them — production measured 250 MB per account, all of it older than any row that could resume it. Only those two artifact shapes are ever candidates; credentials, settings, and the CLI's own state in the same directory are never looked at, symlinks are never followed, and a resume onto a swept transcript is replayed in place rather than failed. Cadence: `SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES`. |

Janitor rules:

| Rule | Meaning |
|---|---|
| **Idempotent** | A sweep that runs twice deletes nothing extra. Safe to re-run, safe to crash mid-sweep. |
| **Jittered interval** | Sweeps never land on a round number, so they do not pile onto request spikes or onto each other after a restart. |
| **Bounded batch deletes** | Fixed-size batches in a loop, never one giant transaction — a 90-day purge in one statement bloats the WAL, holds row locks, and gives autovacuum nothing to reclaim until it commits. The data plane must not feel a sweep. |
| **Bounded batch *writes*, too** | The rule is about statement size, not about deleting: the usage rollup's catch-up window is up to the whole retention floor wide, so it is issued **one statement per UTC day**, oldest first, with the shutdown signal checked between days. A day is the smallest window that can be *replaced* rather than accumulated, which is what keeps each batch idempotent. |
| **One-line summary log per sweep** | What was deleted, per category, with counts and duration. One line, structured. |
| **Windows are configuration** | Every retention number above is an env var, not a constant in code. |

### The scheduler is in-process

**No Redis, no separate worker container, no system cron entry.** The janitor and every other
periodic task are jittered interval timers inside the router process itself, coordinated through the
Postgres you already have. There is nothing extra to deploy, monitor, or back up — deliberately, and
the reasoning (including why not BullMQ/Dragonfly) is in
[01-architecture.md](01-architecture.md#background-work-and-scheduling).

Two operational consequences:

| | |
|---|---|
| **Running multiple router replicas is safe** | Before doing work, each task takes a Postgres advisory lock named for that task. Exactly one replica runs a given sweep; the others fail the try and skip. Scale the router horizontally without a leader-election component and without duplicate sweeps. |
| **Every run is recorded** | Task, start, finish, outcome, and items processed land in a `ScheduledTaskRun` row, surfaced in the admin UI. That record is how you tell a task that is idle from one that is wedged — see Troubleshooting. |

## Reverse proxy

Run HTTPS in front. Cookies are always `Secure`, so the admin UI will not work over plain HTTP
from anything but `localhost`. Every example below disables response buffering explicitly — the
router streams SSE bytes as they arrive (non-negotiable: never buffer a stream), and a proxy that
buffers by default turns a live completion into a multi-second stall before the first token
appears, or a hard cutoff on a long-running one.

```caddyfile
# Caddyfile — TLS is automatic. Caddy does not buffer reverse-proxied responses by
# default, so no extra streaming directive is needed, but keep the timeouts open —
# a completion can legitimately run for the full UPSTREAM_TIMEOUT_MS.
router.example.com {
    reverse_proxy localhost:8080 {
        flush_interval -1   # stream bytes immediately, never batch
    }
}
```

```nginx
server {
    listen 443 ssl http2;
    server_name router.example.com;

    ssl_certificate     /etc/letsencrypt/live/router.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/router.example.com/privkey.pem;

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto $scheme;

        # Streaming responses (SSE) must not be buffered or timed out mid-stream.
        proxy_buffering    off;
        proxy_read_timeout 3600s;
    }
}
```

```yaml
# Traefik — dynamic (file provider) config. Static/router.yml wires the entrypoint
# and cert resolver; this is the piece specific to this router.
http:
  routers:
    multi-ai-router:
      rule: "Host(`router.example.com`)"
      service: multi-ai-router
      tls:
        certResolver: letsencrypt
  services:
    multi-ai-router:
      loadBalancer:
        servers:
          - url: "http://127.0.0.1:8080"
        # Traefik does not buffer proxied responses and has no buffering flag to
        # disable — SSE streams through unmodified by default. The only knob that
        # matters is the transport's response timeout, which defaults to no limit.
```

If you run Traefik via Docker labels instead of the file provider, the equivalent is
`traefik.http.routers.multi-ai-router.rule=Host(\`router.example.com\`)` plus a
`tls.certresolver` label — no buffering label exists to set because there is nothing to disable.

Set `TRUST_PROXY=true` once a proxy is in front, and `PUBLIC_URL=https://router.example.com` if you
want OAuth redirect capture.

**`SESSION_COOKIE_INSECURE` and a reverse proxy don't mix.** The escape hatch exists for a
plain-HTTP install with no proxy in front at all (`http://192.168.1.50:8080` on a LAN) — once any
of the proxies above is terminating TLS, the browser reaches the router over `https://` and the
admin cookie's normal `Secure` + `__Host-` attributes work as designed, so leave
`SESSION_COOKIE_INSECURE` unset (`false`). Setting it **and** running behind a TLS-terminating
proxy gets you the worst of both: no confidentiality benefit (the browser already speaks HTTPS)
and a weaker cookie than you need. It is acceptable only on the bare, proxy-less LAN case above,
and only until HTTPS is put in front — see the env reference above and
[04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie).

**The admin plane may be internet-facing when OIDC-protected.** `/api/admin/**` and the SPA share the same origin and are designed to sit behind HTTPS with the generic OIDC flow in [13-admin-oidc.md](13-admin-oidc.md). A private network, VPN, or IP allowlist remains useful defense in depth, but it is not required for correctness. Never expose the container port directly; terminate TLS at a controlled reverse proxy, keep the client secret and break-glass token in a secret store, pin the one allowed email (and preferably `sub`), and enforce MFA at the IdP. The data plane remains separately authenticated by router keys.

## Persistence & backup

**Two durable things, with different threat models.** The container itself is disposable.

| Volume | Holds | Protected by |
|---|---|---|
| `postgres-data` → `/var/lib/postgresql/data` | Accounts, encrypted credentials, pools, keys, usage, audit | `ENCRYPTION_KEY` — credentials and key values are AES-256-GCM ciphertext inside the rows |
| `claude-config` → `/data/claude` | One `CLAUDE_CONFIG_DIR` per Claude subscription Account, written and refreshed by the `claude` CLI | **Nothing.** These are live credentials in cleartext, owned by the CLI, not by us |

### Database

```bash
# Consistent logical snapshot without stopping anything.
docker compose exec -T postgres pg_dump -U router -d router --format=custom \
  > router-$(date +%F).dump

# Restore into an empty database.
docker compose exec -T postgres pg_restore -U router -d router --clean --if-exists \
  < router-2026-01-01.dump
```

`pg_dump` is the backup; the `postgres-data` volume is the live copy, not a backup — snapshotting it
while Postgres is running produces a torn, possibly unrestorable directory. If you snapshot the
volume anyway (host-level backups often do), stop the service first, or use it only as a supplement
to a dump.

> **The dump is useless without `ENCRYPTION_KEY`.** Every upstream credential and every router key
> inside it is AES-256-GCM ciphertext. Back up **both**, and back them up **separately** — a backup
> that contains the dump and the key side by side is a single-file compromise of your entire account
> pool.

**RPO: however old your last dump is.** There is no continuous replication or WAL shipping in the
shipped stack — a `pg_dump` is a point-in-time snapshot, not a stream, so your recovery point
objective equals your backup interval. Run the automated job below on a schedule that matches how
much re-work (re-minted keys, re-added accounts, lost usage history) you can tolerate losing; hourly
for an active multi-tenant deployment, daily is often fine for a single-operator one. `claude-config`
has no backup story at all by default (see below) — its RPO is "whatever state the volume is in right
now," which is why reconnect-over-restore is the documented recommendation for it.

**Restore drill — practice this before you need it, on a throwaway stack:**

```bash
# 1. Stand up a scratch compose project so the drill never touches the real volume.
docker compose -p router-restore-drill up -d postgres

# 2. Restore the dump into it.
docker compose -p router-restore-drill exec -T postgres \
  pg_restore -U router -d router --clean --if-exists < router-2026-01-01.dump

# 3. Point a throwaway router container at the restored database and boot it —
#    migrations run automatically; a restore from an older schema version
#    proves the forward-only migrations still apply cleanly.
#
#    `run`, not `up`: `run` publishes none of the service's ports, so the drill
#    cannot collide with the real stack's 127.0.0.1:8080 on a host that is
#    already serving. `up -d router` here fails with a port conflict instead of
#    telling you anything about your backup.
docker compose -p router-restore-drill run --rm --no-deps -d router

# 4. Verify, then tear the whole drill down.
docker compose -p router-restore-drill exec -T postgres \
  psql -U router -d router -c "select count(*) from accounts;"
docker compose -p router-restore-drill down -v
```

A dump that only gets opened during a real incident is an unverified backup. Run this drill on a
schedule (monthly is reasonable) and after every schema-changing upgrade, not just once at setup.

**Automated backup**, cron on the Docker host (outside the compose project, since the janitor
inside the router does not back up its own database — see [Cleanups & retention](#cleanups--retention)
above for what it *does* sweep):

```bash
# /etc/cron.d/router-backup — daily at 02:00, keep 14 days, host-side crontab
0 2 * * * root cd /opt/router && docker compose exec -T postgres \
  pg_dump -U router -d router --format=custom > /backups/router-$(date +\%F).dump \
  && find /backups -name 'router-*.dump' -mtime +14 -delete
```

Ship `/backups` off the host (object storage, another machine) — a backup that lives on the same disk
as the volume it protects survives everything except the one failure mode backups exist for.

### Claude config directories

The `claude-config` volume is **secret material and is not covered by `ENCRYPTION_KEY`**. It holds
usable Claude subscription credentials in the form the CLI writes them. Treat it the way you treat
the encryption key itself:

| Rule | Why |
|---|---|
| Mode `0700`, owned by the container's runtime uid | Anything readable by another user on the host is a subscription takeover. The image creates the root at `0700`; keep it that way. |
| Back it up **encrypted**, and separately from the database dump | An unencrypted copy is a usable credential set with no second factor. |
| Never bake it into an image, a build context, or a repo | `.dockerignore` excludes local config trees for exactly this reason. |
| Every subscription in it expires ~30 days after its login, however much it is used | The refresh token does not slide with use (verified in production on accounts serving traffic daily). When it expires the CLI blanks the tokens in `.credentials.json` — the file remains, the account is dead. The router notices within a day (the daily free `claude auth status` sweep) and on the next request (classified `auth`), marks the account `needs_reauth`, and an operator reconnects it from `/accounts`. Plan on a monthly reconnect per subscription; nothing automates a login. |
| It fills with transcripts | One `.jsonl` (+ a directory) per SDK session, never removed by the CLI. The `sdk_transcript_sweep` task removes them after `RETENTION_SDK_TRANSCRIPT_HOURS`; see "Cleanups & retention". |
| Losing it is recoverable, unlike `ENCRYPTION_KEY` | Reconnect each Claude account from `/accounts` and the CLI writes a fresh directory. Annoying, not fatal — restore-vs-reconnect is a judgment call, and reconnecting is often the safer one. |

## Shutdown & draining

`SIGTERM` (and `SIGINT`) start one ordered shutdown. It is the same order as boot, reversed:

| Step | What it does | Bounded by |
|---|---|---|
| 1. Stop being ready | `GET /readyz` starts answering `503 shutting_down` — with `checks: null`, because nothing was probed. Traffic is still served; only the answer to "should you send me more" changed. | immediate |
| 2. Let the balancer notice | Keep serving while whatever routes to this replica reads that `503` and stops. Skipped entirely at the default of `0`. | `SHUTDOWN_READY_GRACE_MS` |
| 3. Stop accepting | The listener closes. In-flight responses keep streaming; new connections are refused. | immediate |
| 4. Drain | In-flight responses — including a completion that is still streaming — get time to finish. | `SHUTDOWN_DRAIN_MS` |
| 5. Flush | Scheduler ticks and the OAuth refresher stop, pending `claude` logins are cancelled, then the queued `UsageRecord`s, quota readings and account statuses are written. | the work in hand |
| 6. Close | The Postgres pool closes and the process exits `0`. A query still running is destroyed at the deadline rather than holding the exit open until the kill lands. | `DB_POOL_CLOSE_TIMEOUT_SECONDS` |

`/healthz` is unaffected and stays `200` throughout. Liveness is not readiness: the process is up
and finishing what it has, and restarting it now would truncate exactly what the drain is protecting.

**Step 2 is what makes step 1 worth doing, and it is off by default.** Once the listener closes, bun
refuses new connections *and* stops dispatching on the keep-alive connections it already had — so
the honest `503` has nobody left to ask for it. The window is when it can be read. The bundled
compose deployment has no readiness gate, so `0` is right there and the step is skipped; on
Kubernetes set roughly two readiness periods (`periodSeconds`, default 10s → `20000`) and raise
`terminationGracePeriodSeconds` to cover it *plus* the drain.

**Step 4 is the one with the deadline that matters, and that is the whole point.** `Bun.serve().stop()` waits for
the last byte of the last response and never gives up, so a shutdown that simply awaited it would
hang for as long as the longest generation in flight — until the orchestrator's `SIGKILL` landed,
which truncates every stream *and* discards everything step 5 was still holding. The drain caps that
wait instead: inside the deadline every response finishes and the flush records what they earned;
past it the wait ends anyway, the flush still runs, and the responses still open are truncated by the
exit — counted and logged (`drain deadline expired — closing responses still in flight`, with
`pending`, `abandoned` and `waitedMs`) rather than lost silently.

Step 6 is bounded for the same reason and one step later: the pool close runs *after* the flush, so
a connection wedged in a long query would hold the exit open past everything the flush just wrote —
with nothing left to gain. `DB_POOL_CLOSE_TIMEOUT_SECONDS` (default `5`) caps it; past that the pool
is destroyed and whatever was still running is rejected.

So **the container's stop grace must exceed the whole budget** — `SHUTDOWN_READY_GRACE_MS` +
`SHUTDOWN_DRAIN_MS` + `DB_POOL_CLOSE_TIMEOUT_SECONDS` — or the kill arrives mid-shutdown and you are
back to losing the flush. A test holds the bundled compose file above the sum of the defaults:

| Runtime | Setting | Default | Ours |
|---|---|---|---|
| Docker / Compose | `stop_grace_period` | 10s — **shorter than the drain** | `30s`, set in the bundled `docker-compose.yml` |
| Kubernetes | `terminationGracePeriodSeconds` | 30s | raise it alongside `SHUTDOWN_READY_GRACE_MS`; the default covers the drain but not a 20s readiness window on top of it |

A **second** signal during the drain means "stop waiting": the process logs it and exits non-zero
immediately, rather than re-entering and running the flush twice against a closing pool.

### PID 1 and the `claude` subprocess

The image's `ENTRYPOINT` runs the router under [tini](https://github.com/krallin/tini), not directly.
That is not ceremony. Every Claude subscription request spawns a `claude` subprocess
([11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md)), and anything *that* process spawns is
re-parented to PID 1 the moment it outlives its parent. PID 1 is the only process the kernel will
hand an orphan to, and a PID 1 that never calls `wait()` accumulates one zombie entry per orphan —
a slow leak of the process table on the longest-running process in the deployment, under a workload
whose defining trait is a subprocess per request. `bun` is not an init and cannot fix this from
inside; reaping is a property of PID 1. tini reaps, forwards `SIGTERM` unchanged so the drain above
still runs, and exits with the router's own status. It runs with `-s`, so the reaping survives
something putting a second init above it (`docker run --init`, compose's `init: true` — neither is
needed, and neither breaks it).

## Upgrades

| Step | Command |
|---|---|
| Pull a new tag | `docker compose pull` |
| Restart | `docker compose up -d` |
| Migrations | Run automatically at boot, before the listener opens. Idempotent. A failed migration exits non-zero and does not serve traffic. |
| Roll back | Pin the previous tag and `docker compose up -d`. Take a `pg_dump` first — a rolled-back binary may not understand a migrated schema, and migrations are forward-only. |
| Postgres major version | Pinned to `postgres:16`. A major bump is a deliberate `pg_dump` / `pg_restore` cycle, never something a `docker compose pull` should do to you — the data directory format changes between majors and the new container will refuse to start on the old one. |

## Image tags

Multi-arch (`linux/amd64`, `linux/arm64`), published to `ghcr.io/developerz-ai/multi-ai-router`.

| Trigger | Tags | Use it for |
|---|---|---|
| `v*` tag | `1.2.3`, `1.2`, `latest` (pre-releases like `v1.3.0-rc.1` skip `latest`) | Everything. Pin at least the minor — there is no bare-major (`1`) tag; `release.yml`'s `merge` job only emits `{version}`, `{major}.{minor}`, and `latest`. |

**A tagged release is the only thing that publishes an image.** Pushing to `main` runs the quality
gate (lint, typecheck, test, build) and stops there — it deliberately publishes nothing.

The reason is that a registry accumulating one image per commit makes "which tag is real" ambiguous,
and a moving `main` tag invites deploying an untagged commit. The release tag is the only ref
anything should deploy. CI still *builds* the artifact on every push, so a commit that cannot
produce one fails immediately rather than at release time.

To cut a release: `git tag v0.1.0 && git push origin v0.1.0`. That fires `release.yml`, which builds
both arches natively, pushes each by digest, merges them into one manifest list under the tags above,
and creates the GitHub release.

### What the image says about itself

Every image carries OCI annotations, so an operator holding a pulled tag can answer "what is this,
and which commit is it" without running it:

```sh
docker buildx imagetools inspect --format '{{json .Manifest.Annotations}}' \
  ghcr.io/developerz-ai/multi-ai-router:1.0.0
```

| Label | Value |
|---|---|
| `org.opencontainers.image.source` / `.url` / `.documentation` | Where the code and the docs live |
| `org.opencontainers.image.licenses` | `MIT` |
| `org.opencontainers.image.version` | The same string `/healthz` reports — `bin/verify-version` refuses a tag whose label disagrees with `packages/core/src/version.ts` |
| `org.opencontainers.image.revision` | The tagged commit's sha, identical to `router_build_info{revision}` inside the container. `unknown` on a local build nobody stamped |

They are declared in the `Dockerfile`, not only in CI, so a local
`docker build -t multi-ai-router:dev .` produces a labelled image too — that is the build least able
to explain itself later. `release.yml` layers `docker/metadata-action`'s richer set (created
timestamp, real sha) on top.

### Base image pinning

Both `Dockerfile` stages pin `oven/bun` by **version and index digest**, and `ci.yml`'s
`BUN_VERSION` pins the same version. A floating `oven/bun:1` would let the image ship a bun the test
suite never ran, and a mutable version tag would let a rebuild of an old release tag produce a
different image from the one that shipped. Both are gated:
`apps/api/test/integration/image-pins.test.ts` fails when the Dockerfile and the workflow disagree,
and each build stage re-asks its base `bun --version` so a digest that does not name the version its
tag claims fails the build rather than the release. Moving the pin: see
[RELEASING.md](../RELEASING.md#moving-the-base-image-pin).

## Performance

This is an **I/O-bound reverse proxy**, not a compute workload: it forwards bytes and waits on
upstreams. The router sits in the hot path of every request every developer and every agent makes,
so **added overhead is a hard budget, not an afterthought**.

**Target: < 5 ms added p99** on the passthrough path, excluding upstream time, and **zero added
time-to-first-token** beyond one network hop. Streams are relayed as bytes arrive — never buffered,
re-chunked, or held for a complete SSE event. Nothing touches Postgres on the critical path (key
verification, account selection, health and quota are served from warm in-memory caches), and usage
records are enqueued and written in batches by a background writer, so a slow database degrades
reporting and never traffic. The `router_overhead_seconds` histogram makes a regression visible; see
[08-observability.md](08-observability.md).

`bin/bench` is how the two claims are checked rather than asserted: it drives the real router against
an in-process stub upstream, reads the overhead percentiles back off `GET /metrics`, measures added
time-to-first-token separately, and exits non-zero when either breaks. Run it when you touch the
request path and before cutting a release — it is not part of `bin/check`, because a timing
measurement on a shared runner is a flaky test. Details and caveats:
[08-observability.md](08-observability.md#verifying-the-budget).

| Scales with | Does not scale with |
|---|---|
| Concurrent open streams — one socket plus a small buffer per in-flight request | CPU cores. Routing is rendezvous hashing over a short array; passthrough parses nothing. |
| **Concurrent Claude-subscription requests** — see below | Model size or prompt length. Big prompts are bytes to forward, not work to do. |
| Usage-record write rate, and retained history on the Postgres volume | Number of configured accounts. Health state is in memory. |

**The Agent-SDK path is the labeled exception, and it is the one that costs real memory.** Claude
subscription accounts go through the Claude Agent SDK, which spawns a `claude` subprocess per
request (spec §11). That is inherently heavier than an HTTP hop, the < 5 ms budget does not apply to
it, and — unlike everything else here — **it consumes memory per concurrent request**, not per
configured account. Subprocess pooling is deferred until there is a measurement to tune against; see
[10-roadmap.md](10-roadmap.md).

### Sizing

Sizing guidance follows directly from that split:

| Workload | Baseline |
|---|---|
| API-key / passthrough accounts only (no Claude subscriptions) | 1 vCPU, 512 MB for the router. Watch open connections; you will run out of file descriptors long before CPU. |
| Claude subscriptions in the pool | Size the router's memory around **peak concurrent subscription requests**, not total accounts or total traffic: budget **~245 MB per concurrent `claude` subprocess** (measured, see below), plus the 512 MB baseline. Ten idle Claude accounts cost nothing; ten simultaneous Claude requests cost ~2.45 GB. |
| Postgres | Modest. The working set is small and the critical path does not touch it — the default container settings are fine until retained usage history gets large. |

**The per-subprocess figure is measured, not guessed.** Spawning the real `claude` CLI binary
locally (single process and in 30-/60-way concurrent batches) and polling `/proc/<pid>/status` for
`VmRSS` at ~5 ms resolution puts a single uncontended process at **~245 MB resident** (three runs:
244.8 / 245.7 / 244.3 MB), reached during startup before any conversational turn — so it is fixed
cost, not something that shrinks for a short prompt. What is **not yet measured** is whether
resident memory grows further across a long-running conversation's turns; that needs a live
authenticated session this environment has no subscription credential to run (see
[10-roadmap.md](10-roadmap.md#open-questions) for the full method and the open half of the
question). Budget the measured ~245 MB as a floor per concurrent request, not a ceiling.

**Concurrency ceiling is a formula, not a fixed number**, and memory is confirmed as the binding
constraint: on a representative Linux host, `ulimit -n` (open files) and `ulimit -u` (max
processes) run in the hundreds of thousands to millions — far above what RAM allows once each
process costs ~245 MB. A box breaks on memory long before it runs out of file descriptors or
process-table slots. Concretely:

```
concurrency_ceiling ≈ (available_RAM_MB − 512_MB_baseline) / 245_MB
```

The `CLAUDE_SDK_MAX_CONCURRENCY` default of `10` costs ~2.45 GB at full occupancy — conservative on
anything but the smallest box, and the right default precisely because it is safe everywhere before
an operator tunes it up against their own RAM using the formula above. Cap concurrency deliberately
rather than discovering the ceiling under load: an unbounded subprocess count is the failure mode.
The ceiling covers **every** path that spawns, dispatch and the console's **Test now** probe alike —
a bound one caller can step around bounds nothing. `router_sdk_subprocesses` and
`router_sdk_subprocess_queue_depth` are how you check the formula against your own traffic:
saturation with an empty queue means the ceiling fits, sustained queue depth means raise it (if RAM
allows) or add a replica. A
same-dialect passthrough (the common case) does no body parsing at all; see
[06-protocol-translation.md](06-protocol-translation.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container exits immediately, log names a variable | Zod env validation failed | Read the named variable in the exit message. Most common: `ENCRYPTION_KEY` is not 32 bytes of base64, or a partial `ADMIN_OIDC_*` block (some of the four set, not all). See [13-admin-oidc.md](13-admin-oidc.md). |
| Container exits immediately, log says "no admin sign-in method is configured" | No `ADMIN_OIDC_*` variables and no local admin password — boot requires one of the two | Set the four OIDC variables, or run `bin/admin set-password` (`docker compose exec router bun run dist/api/admin.js set-password` in the shipped image). See [13-admin-oidc.md](13-admin-oidc.md). |
| Container exits immediately, log names `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC` | A local admin password exists and `PUBLIC_URL` is not loopback — the fail-closed rule for a password-only door on a public address | Remove the password (`bin/admin delete-password`), unset `PUBLIC_URL`, or accept the risk by setting `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC=true`. See [13-admin-oidc.md](13-admin-oidc.md). |
| Account stuck in `needs_reauth` | Background refresh failed — refresh token revoked upstream, password changed, or the provider changed its flow. For a **Claude subscription** the ordinary cause is the calendar: its refresh token hard-expires ~30 days after login regardless of use, the CLI reports `Failed to authenticate: OAuth session expired and could not be refreshed`, and the router parks the account | Click **Reconnect** on `/accounts`. It re-runs the same OAuth flow against the existing row, preserving id, pool membership, and usage history. |
| OAuth callback never returns / provider rejects the redirect URI | `PUBLIC_URL` unset, wrong, or not reachable from your browser; or the provider will not accept your host | Use the **paste-back flow** on the same screen: copy the authorization URL, authorize, paste `code#state` back. It needs no reachable callback and is a first-class path, not a fallback. See [03-providers.md](03-providers.md). |
| Container restarts in a loop, log names a migration | A migration failed. Boot is deliberately fatal here rather than serving a half-migrated schema | `docker compose logs router` names the failing migration. Check the database is reachable and the role may create/alter tables. Restore the last `pg_dump` before retrying a migration that partially applied. |
| Router exits at boot, cannot reach the database | `DATABASE_URL` wrong, or the `postgres` service unhealthy | `docker compose ps` shows the Postgres health state; `docker compose logs postgres` says why. With the bundled service the router waits for `pg_isready`, so this usually means a hand-edited `DATABASE_URL` or a managed instance rejecting the credentials/TLS mode. |
| Account shows a stale reset time — the window looks expired but the account is still skipped, or the provider clearly reset early | The stored reset came from the provider's reported value or a computed estimate, and providers do reset early, lift limits broadly, or restore a balance out of band. The router will not sit on its own clock forever, but it does not poll continuously either | Press **Re-check now** on `/accounts` (per account, or for all at once). It re-queries the provider's live quota signal, updates utilization and reset times, and returns the account to `active` immediately if it is healthy. The outcome shows inline with the time of the last check. Rate-limited per account by `ACCOUNT_RECHECK_COOLDOWN_SECONDS`. Note whether the displayed reset is labeled *reported* or *estimated* — an estimate was always a guess. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Claude subscription account fails every request while API-key accounts work | The `claude` CLI is missing or cannot exec in the image (a native binary built for a different libc), or `CLAUDE_CONFIG_ROOT` is not on the persistent volume | Read `checks.claudeCli` on `/readyz`: it names the resolution rung that won, or `missing`. The image stages the CLI from the SDK's own platform package and proves it execs at build time, so a custom build is the usual cause — keep builder and runtime on the same libc. Confirm the `claude-config` volume is mounted and owned by the container's uid — a fresh, empty config directory presents as an account that never authenticates. |
| All accounts `cooling_down`, requests fail | Every candidate hit a `429` or a circuit breaker and none has reset yet | Check reset times on `/accounts`. Add another account to the pool, or move the key to a pool with a paid-API fallback via `priority-failover`. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Clients get `401` | Key revoked, expired, wrong value, or both auth headers sent and disagreeing | Re-copy the key from `/keys`. Send exactly one of `Authorization: Bearer` or `x-api-key`. See [04-api-keys-and-access.md](04-api-keys-and-access.md). |
| Admin SSO returns “Single sign-on verification failed” | Discovery, JWKS, state, token claims, or the configured principal check failed | Start a fresh login and inspect the bounded `[admin-oidc] complete failed: <kind>` server log. Match the kind against [13-admin-oidc.md](13-admin-oidc.md#troubleshooting). Never paste the callback URL, code, state, ID token, or client secret into an issue. |
| Console login says it succeeded, then every screen bounces back to the login form ("session expired") | The router is reached over plain `http://` (a LAN install, or a proxy that does not forward `X-Forwarded-Proto`), so the browser silently discarded the `Secure` session cookie. The OIDC verification itself was genuinely fine, which is why no provider error names the problem | `docker compose logs router` carries a `warn` from the callback: *"login succeeded but the session cookie is Secure and this request arrived over plain HTTP"*, with the remedy in the same line. Either set `SESSION_COOKIE_INSECURE=true` (plain-HTTP install), or terminate HTTPS in front and forward `X-Forwarded-Proto` — the header is honored for this check whether or not `TRUST_PROXY` is on. See [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie). |
| A sweep hasn't run — the DB keeps growing, or usage rollups stop appearing | The scheduler runs in-process, so a wedged or crashed task is invisible unless you look at its last-run record | Check the task's last `ScheduledTaskRun` (admin UI, or the row directly): a stale `startedAt` with a null `finishedAt` means a run was killed halfway or is stuck holding the advisory lock; a stale `startedAt` with `outcome: failed` names the error. `outcome: partial` is normal and means the batch limit was hit and the next run continues. If every replica shows nothing, no replica is acquiring the lock — check Postgres connectivity and `JANITOR_INTERVAL_MINUTES`. |
| `/readyz` red, `/healthz` green | Postgres unreachable or zero healthy accounts | `/healthz` is liveness only, by design — zero healthy accounts is an operator problem, not a reason to restart a working process. Check `docker compose ps postgres` and account health. See [08-observability.md](08-observability.md). |
| `GET /metrics` returns `401` | `METRICS_TOKEN` is set and Prometheus (or your scrape client) is not sending it, or is sending it as the wrong header | `/metrics` has its own credential, separate from both the admin session and router keys — neither is accepted here. Send `Authorization: Bearer <METRICS_TOKEN>`. Leaving `METRICS_TOKEN` unset removes the check entirely; that is the intended posture for a single-host deployment where `/metrics` is not reachable outside its own network — see [08-observability.md](08-observability.md). |
| A revoked or edited router key still authenticates for a while, on some but not all replicas | Verified keys are cached in memory per process so verification does not round-trip Postgres on every request; admin revoke/edit calls `invalidate()` on the replica that served the request, and only on that one | Expected, bounded staleness: **invalidation is immediate on the serving replica, and every other replica keeps accepting the key for up to `KEY_CACHE_TTL_SECONDS` (60 seconds by default)** — that setting is the bound, so read it from your own environment rather than assuming the default. A revoked key stops working everywhere within that window with zero replica coordination, since a compromised key is not a reason to add a broker (non-negotiable: background work is in-process only, no Redis/pub-sub). If a key must be dead **immediately** on every replica, there is no faster path today than lowering the TTL — which costs a Postgres round-trip per uncached verification. See [04-api-keys-and-access.md](04-api-keys-and-access.md#verification-path). |

## Read next

| Doc | Covers |
|---|---|
| [07-security.md](07-security.md) | Encryption at rest, redaction, rate limits, threat framing |
| [13-admin-oidc.md](13-admin-oidc.md) | OIDC client registration, principal pins, callback security, troubleshooting |
| [08-observability.md](08-observability.md) | `/metrics`, `/healthz`, `/readyz`, structured logs |
| [10-roadmap.md](10-roadmap.md) | Milestones, deferrals, maintenance posture |
