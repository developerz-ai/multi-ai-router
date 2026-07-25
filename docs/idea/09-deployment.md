# Deployment and Ops

Status: the compose file, the image, boot-time migrations, and the full environment reference below
are **implemented and shipped**. The janitor and every other periodic task are **not** — the
retention windows below are validated configuration that nothing sweeps on yet.

## The promise

**`docker compose up -d`, three env vars you set by hand.** No hash-generation step before first
login, no database to provision.

`docker compose up -d` brings up **two services**: the router and a PostgreSQL 16 container, with a
named volume for the Postgres data directory and a health check gating the router's start. The
compose file supplies `DATABASE_URL` itself, so the operator still fills in exactly three values —
`ADMIN_USERNAME`, `ADMIN_PASSWORD`, `ENCRYPTION_KEY` — in `.env`.

```yaml
# docker-compose.yml — abridged; the shipped file carries the full comments
services:
  router:
    image: ghcr.io/developerz-ai/multi-ai-router:latest
    ports: ["8080:8080"]
    env_file: [.env]                 # the three you set
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
cp .env.example .env      # set ADMIN_USERNAME, ADMIN_PASSWORD, ENCRYPTION_KEY
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

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ADMIN_USERNAME` | yes | — | The single admin identity. No user table in v1. |
| `ADMIN_PASSWORD` | one of | — | Plaintext password. Hashed with argon2id at boot, never persisted in plaintext. The documented default. |
| `ADMIN_PASSWORD_HASH` | one of | — | Pre-computed argon2id hash, for operators who refuse a plaintext secret in an env store. |
| `ENCRYPTION_KEY` | yes | — | 32 bytes, base64. AES-256-GCM key for upstream credentials and router keys. Boot fails loudly if missing or short. |
| `DATABASE_URL` | yes | — | PostgreSQL 16+ connection string. **Supplied by the bundled compose file**, so it is not one of the three you set by hand. Set it yourself only when pointing at an existing/managed instance. |
| `PORT` | no | `8080` | Listen port inside the container. |
| `CLAUDE_CONFIG_ROOT` | no | `/data/claude` | Parent directory holding one `CLAUDE_CONFIG_DIR` per Claude subscription Account. Must sit on the persistent `claude-config` volume. Secret material — see [Persistence & backup](#persistence--backup). |
| `CLAUDE_CLI_PATH` | no | — | Pins the `claude` binary the Agent SDK spawns, bypassing resolution. Unset is right: the image stages one on `PATH` and `/readyz` reports which rung of the ladder won. A set-but-unusable path **fails** rather than falling back, so the router never spawns a binary you did not name — see [11-anthropic-agent-sdk.md](11-anthropic-agent-sdk.md#9-operational-notes). |
| `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | no | `60` | Minimum interval between manual **Re-check now** probes of the same account. The button re-queries the provider's live quota signal; this is what stops it being used to hammer an upstream. |
| `PUBLIC_URL` | no | — | Externally reachable base URL. Only used to build the OAuth redirect-capture callback (`PUBLIC_URL + /admin/accounts/oauth/callback`). Unset → paste-back capture only. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. Structured JSON either way. |
| `METRICS_TOKEN` | no | — | Bearer token `GET /metrics` demands (`Authorization: Bearer …`). Unset leaves the endpoint open, which is right only where its port is not routable from outside the host. The exposition carries account, key and pool ids — never a credential. |
| `TRUST_PROXY` | no | `false` | Honor `X-Forwarded-For` / `-Proto`. Set `true` **only** behind a proxy you control — otherwise clients can forge their own IP past the rate limiter. |
| `RETENTION_SESSIONS_HOURS` | no | `24` | Idle sticky-session and fingerprint TTL. |
| `RETENTION_USAGE_DAYS` | no | `90` | Raw `UsageRecord` retention before roll-up to daily aggregates. |
| `RETENTION_AUDIT_DAYS` | no | `365` | `AuditEvent` retention. |
| `RETENTION_REVOKED_KEYS_DAYS` | no | `30` | How long a revoked/expired `ApiKey` row survives before purge. |
| `RETENTION_OAUTH_STATE_MINUTES` | no | `10` | TTL for one-shot OAuth `state` + PKCE verifiers. |
| `JANITOR_INTERVAL_MINUTES` | no | `60` | Base sweep interval; the janitor jitters around it. |
| `ADMIN_SESSION_IDLE_MINUTES` | no | `480` | Sliding idle window, and the session cookie's `Max-Age`. Raising it leaves an abandoned browser a live credential for longer. |
| `ADMIN_SESSION_ABSOLUTE_HOURS` | no | `24` | Hard ceiling on a session's total life regardless of activity. A purely sliding session is one a thief renews forever. |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | no | `5` | Failed logins per throttle key (per IP, per username) before it locks. |
| `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES` | no | `15` | Failures older than this stop counting toward the lock. |
| `ADMIN_LOGIN_LOCKOUT_MINUTES` | no | `15` | How long a tripped throttle key stays locked. |
| `CATALOG_REFRESH_SECONDS` | no | `30` | How long the warm routing catalog may lag a write made by **another replica**. A write by this replica refreshes it immediately, so this bounds only the multi-replica case. |
| `KEY_CACHE_MAX` | no | `4096` | Verified router keys held in memory. The ceiling is memory, not correctness — an evicted key costs one indexed lookup. |
| `KEY_CACHE_TTL_SECONDS` | no | `60` | How long a successful verification is reused. Revocation invalidates immediately, so this bounds staleness of a key's limits and scope, not of its revocation. |
| `KEY_CACHE_NEGATIVE_TTL_SECONDS` | no | `5` | How long a failed lookup is remembered. Short on purpose: it stops a flood of bad keys becoming a flood of queries, and a just-minted key must start working quickly. |
| `USAGE_QUEUE_MAX` | no | `10000` | `UsageRecord` rows queued before the writer sheds the oldest. Overflow degrades reporting, never traffic. |
| `USAGE_BATCH_SIZE` | no | `200` | Rows per insert. Larger means fewer round trips and a bigger loss if the process dies mid-queue. |
| `ROUTING_MAX_ATTEMPTS` | no | `3` | Distinct accounts tried for one client request before the honest failure. Never overrides the rule that an attempt is not retried once bytes are on the wire. |
| `ROUTING_FAILURE_THRESHOLD` | no | `3` | Consecutive 5xx or connection failures before an account's breaker trips. |
| `ROUTING_BASE_BACKOFF_MS` | no | `1000` | First cooldown step; doubles per consecutive failure. |
| `ROUTING_MAX_BACKOFF_MS` | no | `300000` | Ceiling on that doubling, so a long outage does not park an account for hours. |
| `UPSTREAM_TIMEOUT_MS` | no | `600000` | How long the router waits on one upstream. Long, because a long completion is a normal response and not a hung one. |
| `TRANSLATE_DEFAULT_MAX_TOKENS` | no | `4096` | The `max_tokens` an Anthropic account is given when the client spoke a dialect that makes it optional and sent none. Anthropic requires the field; the default is generous on purpose, because a low value truncates answers nobody asked to truncate. |
| `USAGE_FLUSH_INTERVAL_MS` | no | `1000` | Drain cadence. Raising it widens the window in which a crash loses unwritten usage rows; it never affects request latency. |

The last two groups are the request path's own tunables: nothing there queries Postgres, so those
values are what decide how quickly it learns about a change and how much memory it spends not
having to. Defaults mirror the layer constants they override, so an unset variable and a variable
set to its default behave identically.

**Admin credential precedence:** when both are set, `ADMIN_PASSWORD_HASH` wins and
`ADMIN_PASSWORD` is ignored. **Exactly one of the two must be present or boot fails.**

Generate an encryption key with `openssl rand -base64 32`. Losing it loses every stored credential —
there is no recovery path. See [07-security.md](07-security.md).

## Cleanups & retention

One background janitor service, one schedule, every window env-tunable.

| What | Default retention | Env var | Why |
|---|---|---|---|
| Idle sessions (sticky map + fingerprints) | 24 h since last use | `RETENTION_SESSIONS_HOURS` | Unbounded growth otherwise; Claude-Code-style long-lived sessions must expire. |
| In-memory LRU caches (session, fingerprint, health) | bounded size, coordinated eviction | — | A fingerprint entry must die with its session. |
| Usage records | 90 days raw → rolled up to daily aggregates | `RETENTION_USAGE_DAYS` | Keeps the dashboard fast and the DB small. |
| Audit events | 365 days | `RETENTION_AUDIT_DAYS` | Compliance-ish; never contains secrets. |
| Expired/consumed OAuth state & PKCE verifiers | 10 min | `RETENTION_OAUTH_STATE_MINUTES` | One-shot values. |
| Revoked / expired API keys | 30 days after revocation, then purged | `RETENTION_REVOKED_KEYS_DAYS` | Keeps historical usage joinable for a while. |
| Rate-limit & circuit-breaker state | expires with its reset window | — | Derived state, not durable state. |

Janitor rules:

| Rule | Meaning |
|---|---|
| **Idempotent** | A sweep that runs twice deletes nothing extra. Safe to re-run, safe to crash mid-sweep. |
| **Jittered interval** | Sweeps never land on a round number, so they do not pile onto request spikes or onto each other after a restart. |
| **Bounded batch deletes** | Fixed-size batches in a loop, never one giant transaction — a 90-day purge in one statement bloats the WAL, holds row locks, and gives autovacuum nothing to reclaim until it commits. The data plane must not feel a sweep. |
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
from anything but `localhost`.

```caddyfile
# Caddyfile — TLS is automatic
router.example.com {
    reverse_proxy localhost:8080
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

Set `TRUST_PROXY=true` once a proxy is in front, and `PUBLIC_URL=https://router.example.com` if you
want OAuth redirect capture.

**Do not publicly expose the admin plane.** `/api/admin/**` and the SPA are protected by one
password. Keep them on a private network, a VPN, or behind an IP allowlist in the proxy, and expose
only `/v1/**` publicly if clients need to reach the router from the internet. The data plane is
designed for hostile callers; the admin plane is not.

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

### Claude config directories

The `claude-config` volume is **secret material and is not covered by `ENCRYPTION_KEY`**. It holds
usable Claude subscription credentials in the form the CLI writes them. Treat it the way you treat
the encryption key itself:

| Rule | Why |
|---|---|
| Mode `0700`, owned by the container's runtime uid | Anything readable by another user on the host is a subscription takeover. The image creates the root at `0700`; keep it that way. |
| Back it up **encrypted**, and separately from the database dump | An unencrypted copy is a usable credential set with no second factor. |
| Never bake it into an image, a build context, or a repo | `.dockerignore` excludes local config trees for exactly this reason. |
| Losing it is recoverable, unlike `ENCRYPTION_KEY` | Reconnect each Claude account from `/accounts` and the CLI writes a fresh directory. Annoying, not fatal — restore-vs-reconnect is a judgment call, and reconnecting is often the safer one. |

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
| `v*` tag | `1.2.3`, `1.2`, `1`, `latest` | Everything. Pin at least the minor. |

**A tagged release is the only thing that publishes an image.** Pushing to `main` runs the quality
gate (lint, typecheck, test, build) and stops there — it deliberately publishes nothing.

The reason is that a registry accumulating one image per commit makes "which tag is real" ambiguous,
and a moving `main` tag invites deploying an untagged commit. The release tag is the only ref
anything should deploy. CI still *builds* the artifact on every push, so a commit that cannot
produce one fails immediately rather than at release time.

To cut a release: `git tag v0.1.0 && git push origin v0.1.0`. That fires `release.yml`, which builds
both arches natively, pushes each by digest, merges them into one manifest list under the tags above,
and creates the GitHub release.

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
| Claude subscriptions in the pool | Size the router's memory around **peak concurrent subscription requests**, not total accounts or total traffic: budget for one `claude` subprocess each, plus the 512 MB baseline. Ten idle Claude accounts cost nothing; ten simultaneous Claude requests do. |
| Postgres | Modest. The working set is small and the critical path does not touch it — the default container settings are fine until retained usage history gets large. |

Cap concurrency deliberately rather than discovering the ceiling under load: a subscription-heavy
deployment is memory-bound, and an unbounded subprocess count is the failure mode. A same-dialect
passthrough (the common case) does no body parsing at all; see
[06-protocol-translation.md](06-protocol-translation.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Container exits immediately, log names a variable | Zod env validation failed | Read the named variable in the exit message. Most common: `ENCRYPTION_KEY` not 32 bytes of base64, or neither `ADMIN_PASSWORD` nor `ADMIN_PASSWORD_HASH` set. |
| Account stuck in `needs_reauth` | Background refresh failed — refresh token revoked upstream, password changed, or the provider changed its flow | Click **Reconnect** on `/accounts`. It re-runs the same OAuth flow against the existing row, preserving id, pool membership, and usage history. |
| OAuth callback never returns / provider rejects the redirect URI | `PUBLIC_URL` unset, wrong, or not reachable from your browser; or the provider will not accept your host | Use the **paste-back flow** on the same screen: copy the authorization URL, authorize, paste `code#state` back. It needs no reachable callback and is a first-class path, not a fallback. See [03-providers.md](03-providers.md). |
| Container restarts in a loop, log names a migration | A migration failed. Boot is deliberately fatal here rather than serving a half-migrated schema | `docker compose logs router` names the failing migration. Check the database is reachable and the role may create/alter tables. Restore the last `pg_dump` before retrying a migration that partially applied. |
| Router exits at boot, cannot reach the database | `DATABASE_URL` wrong, or the `postgres` service unhealthy | `docker compose ps` shows the Postgres health state; `docker compose logs postgres` says why. With the bundled service the router waits for `pg_isready`, so this usually means a hand-edited `DATABASE_URL` or a managed instance rejecting the credentials/TLS mode. |
| Account shows a stale reset time — the window looks expired but the account is still skipped, or the provider clearly reset early | The stored reset came from the provider's reported value or a computed estimate, and providers do reset early, lift limits broadly, or restore a balance out of band. The router will not sit on its own clock forever, but it does not poll continuously either | Press **Re-check now** on `/accounts` (per account, or for all at once). It re-queries the provider's live quota signal, updates utilization and reset times, and returns the account to `active` immediately if it is healthy. The outcome shows inline with the time of the last check. Rate-limited per account by `ACCOUNT_RECHECK_COOLDOWN_SECONDS`. Note whether the displayed reset is labeled *reported* or *estimated* — an estimate was always a guess. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Claude subscription account fails every request while API-key accounts work | The `claude` CLI is missing or cannot exec in the image (a native binary built for a different libc), or `CLAUDE_CONFIG_ROOT` is not on the persistent volume | Read `checks.claudeCli` on `/readyz`: it names the resolution rung that won, or `missing`. The image stages the CLI from the SDK's own platform package and proves it execs at build time, so a custom build is the usual cause — keep builder and runtime on the same libc. Confirm the `claude-config` volume is mounted and owned by the container's uid — a fresh, empty config directory presents as an account that never authenticates. |
| All accounts `cooling_down`, requests fail | Every candidate hit a `429` or a circuit breaker and none has reset yet | Check reset times on `/accounts`. Add another account to the pool, or move the key to a pool with a paid-API fallback via `priority-failover`. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Clients get `401` | Key revoked, expired, wrong value, or both auth headers sent and disagreeing | Re-copy the key from `/keys`. Send exactly one of `Authorization: Bearer` or `x-api-key`. See [04-api-keys-and-access.md](04-api-keys-and-access.md). |
| A sweep hasn't run — the DB keeps growing, or usage rollups stop appearing | The scheduler runs in-process, so a wedged or crashed task is invisible unless you look at its last-run record | Check the task's last `ScheduledTaskRun` (admin UI, or the row directly): a stale `startedAt` with a null `finishedAt` means a run was killed halfway or is stuck holding the advisory lock; a stale `startedAt` with `outcome: failed` names the error. `outcome: partial` is normal and means the batch limit was hit and the next run continues. If every replica shows nothing, no replica is acquiring the lock — check Postgres connectivity and `JANITOR_INTERVAL_MINUTES`. |
| `/readyz` red, `/healthz` green | Postgres unreachable or zero healthy accounts | `/healthz` is liveness only, by design — zero healthy accounts is an operator problem, not a reason to restart a working process. Check `docker compose ps postgres` and account health. See [08-observability.md](08-observability.md). |

## Read next

| Doc | Covers |
|---|---|
| [07-security.md](07-security.md) | Encryption at rest, redaction, rate limits, threat framing |
| [08-observability.md](08-observability.md) | `/metrics`, `/healthz`, `/readyz`, structured logs |
| [10-roadmap.md](10-roadmap.md) | Milestones, deferrals, maintenance posture |
