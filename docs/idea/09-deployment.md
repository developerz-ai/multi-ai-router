# Deployment and Ops

Status: the compose file, the image, boot-time migrations, and the full environment reference below
are **implemented and shipped**. The janitor and every other periodic task (usage rollup, OAuth-state
purge, quota floor) are also shipped — in-process jittered timers, one `pg_try_advisory_lock` per
task, last run and outcome recorded to `ScheduledTaskRun` — and the retention windows below are what
they sweep against.

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
| `CLAUDE_SDK_MAX_CONCURRENCY` | no | `10` | `claude` subprocesses in flight on this replica. Every subscription request spawns one (~245 MB native binary, measured — see [Sizing](#sizing)), so this is a **memory** bound, not a throughput one — size against RAM, not CPUs. Requests over the ceiling queue rather than fail. Bounds every spawner, including the console's **Test now** button. Watch `router_sdk_subprocesses` and `router_sdk_subprocess_queue_depth` to size it against real traffic. |
| `CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT` | no | `4` | The same ceiling for any one subscription Account — what stops one Account's burst starving the pool. Values above `CLAUDE_SDK_MAX_CONCURRENCY` are legal and simply never bind. |
| `ACCOUNT_RECHECK_COOLDOWN_SECONDS` | no | `60` | Minimum interval between manual **Re-check now** probes of the same account. The button re-queries the provider's live quota signal; this is what stops it being used to hammer an upstream. |
| `ACCOUNT_TEST_NOW_COOLDOWN_SECONDS` | no | `120` | Minimum interval between manual **Test now** presses of the same account. Distinct from the re-check cooldown above and deliberately longer: this button sends one real, billed completion, and on a Claude subscription it spawns a `claude` subprocess and spends a turn. |
| `PUBLIC_URL` | no | — | Externally reachable base URL. Only used to build the OAuth redirect-capture callback (`PUBLIC_URL + /admin/accounts/oauth/callback`). Unset → paste-back capture only. |
| `WEB_ROOT` | no | `dist/web` beside the bundled entrypoint | Directory holding the built admin console, which the router serves at `/` on its own origin. The default is correct in the image; set it only when the assets live elsewhere. Set-but-missing an `index.html` **fails boot** rather than quietly serving an API-only router that looks like a broken web app. Absent assets at the default path are not fatal — that is what running from source looks like, and Vite serves the console itself in dev. |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error`. Structured JSON either way. |
| `METRICS_TOKEN` | no | — | Bearer token `GET /metrics` demands (`Authorization: Bearer …`). Unset leaves the endpoint open, which is right only where its port is not routable from outside the host. The exposition carries account, key and pool ids — never a credential. |
| `ROUTER_REVISION` | no | `unknown` | Which commit this build is, reported by `router_build_info{revision}` and the `router listening` boot log line. The published image bakes in the tagged commit's sha (`--build-arg ROUTER_REVISION=…`); a version alone cannot separate a rebuilt `latest` from the tag it was cut for. Set it by hand only when you build your own image. |
| `TRUST_PROXY` | no | `false` | Honor `X-Forwarded-For` / `-Proto`. Set `true` **only** behind a proxy you control — otherwise clients can forge their own IP past the rate limiter. |
| `RETENTION_SESSIONS_HOURS` | no | `24` | Idle sticky-session and fingerprint TTL. |
| `RETENTION_USAGE_DAYS` | no | `90` | Raw `UsageRecord` retention before roll-up to daily aggregates. |
| `RETENTION_AUDIT_DAYS` | no | `365` | `AuditEvent` retention. |
| `RETENTION_REVOKED_KEYS_DAYS` | no | `30` | How long a revoked/expired `ApiKey` row survives before purge. |
| `RETENTION_OAUTH_STATE_MINUTES` | no | `10` | TTL for one-shot OAuth `state` + PKCE verifiers. |
| `RETENTION_ORPHAN_CONFIG_DIR_HOURS` | no | `24` | Grace before a `CLAUDE_CONFIG_DIR` under `CLAUDE_CONFIG_ROOT` that no account claims is removed. A directory is provisioned just *before* its account row is inserted, so this must comfortably exceed that gap — too short and the reaper deletes a login still being made. |
| `JANITOR_INTERVAL_MINUTES` | no | `60` | Base sweep interval; the janitor jitters around it. |
| `USAGE_ROLLUP_INTERVAL_MINUTES` | no | `60` | Usage record rollup interval, in minutes. Raw records older than `RETENTION_USAGE_DAYS` are summarized into daily aggregates. |
| `OAUTH_STATE_PURGE_INTERVAL_MINUTES` | no | `5` | OAuth state (and PKCE verifier) purge interval, in minutes. One-shot values older than `RETENTION_OAUTH_STATE_MINUTES` are deleted. |
| `QUOTA_FLOOR_INTERVAL_MINUTES` | no | `30` | Account quota floor probe interval, in minutes. Periodic refresh of cached quota state. |
| `CONFIG_DIR_REAP_INTERVAL_MINUTES` | no | `360` | How often the orphaned-`CLAUDE_CONFIG_DIR` reap runs. Hours rather than minutes: an orphan is a crash artifact. *How long* one may linger is `RETENTION_ORPHAN_CONFIG_DIR_HOURS`, not this. |
| `ADMIN_SESSION_PURGE_INTERVAL_MINUTES` | no | `30` | How often expired admin console sessions are dropped from the in-memory `SessionStore`. Runs on every replica independently — the store is process memory, not a table, so there is nothing for the advisory lock to coordinate. |
| `SWEEP_BATCH_SIZE` | no | `1000` | Max rows per bounded-delete sweep (usage, session, revoked keys, audit, OAuth state), and directories per orphaned-config-dir reap. Larger trades memory and latency for fewer sweeps; smaller means more passes. |
| `SCHEDULER_JITTER_FRACTION` | no | `0.2` | Jitter applied to task intervals as a fraction of the interval. E.g., `0.2` means ±20% around the base value, spreading load after a restart. |
| `OAUTH_REFRESH_LEAD_FRACTION` | no | `0.75` | Share of a router-held OAuth token's remaining lifetime allowed to elapse before it is refreshed — `0.75` refreshes with a quarter of the lifetime in hand. Not an interval: refresh is per account and expiry-driven, never a poll. Claude subscriptions are unaffected; the Agent SDK owns those tokens. |
| `OAUTH_REFRESH_MIN_DELAY_SECONDS` | no | `30` | Floor on any refresh delay, and the first step of the retry backoff. What stops an already-expired token from re-arming at zero and hammering the provider. |
| `OAUTH_REFRESH_MAX_ATTEMPTS` | no | `5` | Attempts against an unreachable token endpoint before the account is parked at `needs_reauth`. A *refused* refresh is never retried — only a clock fixes an outage. |
| `ADMIN_SESSION_IDLE_MINUTES` | no | `480` | Sliding idle window, and the session cookie's `Max-Age`. Raising it leaves an abandoned browser a live credential for longer. |
| `ADMIN_SESSION_ABSOLUTE_HOURS` | no | `24` | Hard ceiling on a session's total life regardless of activity. A purely sliding session is one a thief renews forever. |
| `ADMIN_LOGIN_MAX_ATTEMPTS` | no | `5` | Failed logins per throttle key (per IP, per username) before it locks. |
| `ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES` | no | `15` | Failures older than this stop counting toward the lock. |
| `ADMIN_LOGIN_LOCKOUT_MINUTES` | no | `15` | How long a tripped throttle key stays locked. |
| `ADMIN_SESSION_SLIDE_FRACTION` | no | `0.1` | Share of the idle window a session must advance since its last persisted `lastSeenAtMs` before the slide is written back to the session store. The in-memory value is authoritative for every response regardless; this only throttles the store write, so a Postgres-backed store sees roughly one write per fraction-of-idle-window instead of one per authenticated request. |
| `SESSION_COOKIE_INSECURE` | no | `false` | Drops `Secure` and the `__Host-` prefix from the admin session cookie. The escape hatch for a **plain-HTTP install** (`http://192.168.1.50:8080` on a LAN), which is otherwise unusable: a browser silently discards a `Secure` cookie sent over `http://`, so login answers `200` and every request after it is `401`. `HttpOnly`, `SameSite=Strict` and the CSRF token are unaffected. What you give up is confidentiality on the wire and the `__Host-` guarantee that no sibling host under this domain can plant a session cookie — so unset it once HTTPS is in front. Leaving it unset on a plain-HTTP install is diagnosed for you: the login logs a `warn` naming this variable. Turning it on logs a `warn` on every boot while it is on. See [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie). |
| `CATALOG_REFRESH_SECONDS` | no | `30` | How long the warm routing catalog may lag a write made by **another replica**. A write by this replica refreshes it immediately, so this bounds only the multi-replica case. |
| `KEY_CACHE_MAX` | no | `4096` | Verified router keys held in memory. The ceiling is memory, not correctness — an evicted key costs one indexed lookup. |
| `KEY_CACHE_TTL_SECONDS` | no | `60` | How long a successful verification is reused. Revocation invalidates immediately on the replica that served the admin request, so on a single-replica deployment this bounds staleness of a key's limits and scope, not of its revocation — on several replicas it bounds both, for every replica but that one. |
| `KEY_CACHE_NEGATIVE_TTL_SECONDS` | no | `5` | How long a failed lookup is remembered. Short on purpose: it stops a flood of bad keys becoming a flood of queries, and a just-minted key must start working quickly. |
| `SESSION_CACHE_MAX` | no | `4096` | Session → Account bindings held in memory, plus their fingerprint aliases. Only Claude subscription accounts ever create one. |
| `SESSION_CACHE_TTL_SECONDS` | no | `300` | How long a binding is reused before its row is re-read. Bounds only how long this replica may lag another one's rebind; the row itself never expires, because an SDK session outlives any cache. |
| `SESSION_CACHE_NEGATIVE_TTL_SECONDS` | no | `30` | How long "this session has no binding" is remembered. Short, and for the opposite reason: it keeps plain HTTP traffic on a subscription-serving router from re-asking Postgres every request. |
| `USAGE_QUEUE_MAX` | no | `10000` | `UsageRecord` rows queued before the writer sheds the oldest. Overflow degrades reporting, never traffic. |
| `USAGE_BATCH_SIZE` | no | `200` | Rows per insert. Larger means fewer round trips and a bigger loss if the process dies mid-queue. |
| `ROUTING_MAX_ATTEMPTS` | no | `3` | Distinct accounts tried for one client request before the honest failure. Never overrides the rule that an attempt is not retried once bytes are on the wire. |
| `ROUTING_FAILURE_THRESHOLD` | no | `3` | Consecutive 5xx or connection failures before an account's breaker trips. |
| `ROUTING_BASE_BACKOFF_MS` | no | `1000` | First cooldown step; doubles per consecutive failure. |
| `ROUTING_MAX_BACKOFF_MS` | no | `300000` | Ceiling on that doubling, so a long outage does not park an account for hours. |
| `ROUTING_HALF_OPEN_HOLD_MS` | no | `30000` | How long the one request admitted onto a recovering account holds it. Everyone else gets `429` with this instant until the probe reports, so the backlog built up during a cooldown cannot stampede the account the moment it returns. Released on the probe's verdict, so this only governs a probe that never reports. |
| `UPSTREAM_TIMEOUT_MS` | no | `600000` | How long the router waits on one upstream. Long, because a long completion is a normal response and not a hung one. |
| `TRANSLATE_DEFAULT_MAX_TOKENS` | no | `4096` | The `max_tokens` an Anthropic account is given when the client spoke a dialect that makes it optional and sent none. Anthropic requires the field; the default is generous on purpose, because a low value truncates answers nobody asked to truncate. |
| `USAGE_FLUSH_INTERVAL_MS` | no | `1000` | Drain cadence. Raising it widens the window in which a crash loses unwritten usage rows; it never affects request latency. |
| `QUOTA_WRITE_INTERVAL_MS` | no | `5000` | How often quota readings observed on responses are persisted to `quota_windows`. Not a poll — a reading only exists once a response reported one. Raising it widens the window in which a crash loses the freshest reading, and how stale the gauges are on a replica that did not serve the request. Never affects request latency: the write is coalesced per account and never awaited by one. |
| `MAX_REQUEST_BODY_BYTES` | no | `33554432` (32 MiB) | The largest request body the router will read. Over it: `413` `request_too_large`, refused before any account is dialed. A declared `Content-Length` over the ceiling is turned away without reading a byte, so a hostile body never gets the ceiling's worth of buffering; a body that lies about its length is still caught as it streams. Raise it for agents that paste whole repositories into a prompt, lower it to bound what one in-flight request can cost in memory. |
| `ACCOUNT_STATUS_WRITE_INTERVAL_MS` | no | `1000` | How often a standing block the breaker just formed — `exhausted`, `needs_reauth` — is written through to `accounts.status`. Not a poll, and not a cooldown: a cooldown is clock-recoverable and deliberately stays in memory. Shorter than the quota interval because what it bounds is worse — a lost reading costs a stale gauge, a lost block costs the operator the banner telling them an account needs topping up. Routing is unaffected at any setting; the breaker holds the verdict either way. |

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
| Orphaned `CLAUDE_CONFIG_DIR`s on the volume | 24 h unclaimed | `RETENTION_ORPHAN_CONFIG_DIR_HOURS` | **Not a disk-space sweep.** Each holds a subscription's OAuth credentials in cleartext; one whose account no longer exists is a credential nothing will ever rotate or revoke. Only names that are account ids are candidates, and only past the grace — the directory is created *before* its row, so a young one may be a login still being made. |

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
| Container exits immediately, log names a variable | Zod env validation failed | Read the named variable in the exit message. Most common: `ENCRYPTION_KEY` not 32 bytes of base64, or neither `ADMIN_PASSWORD` nor `ADMIN_PASSWORD_HASH` set. |
| Account stuck in `needs_reauth` | Background refresh failed — refresh token revoked upstream, password changed, or the provider changed its flow | Click **Reconnect** on `/accounts`. It re-runs the same OAuth flow against the existing row, preserving id, pool membership, and usage history. |
| OAuth callback never returns / provider rejects the redirect URI | `PUBLIC_URL` unset, wrong, or not reachable from your browser; or the provider will not accept your host | Use the **paste-back flow** on the same screen: copy the authorization URL, authorize, paste `code#state` back. It needs no reachable callback and is a first-class path, not a fallback. See [03-providers.md](03-providers.md). |
| Container restarts in a loop, log names a migration | A migration failed. Boot is deliberately fatal here rather than serving a half-migrated schema | `docker compose logs router` names the failing migration. Check the database is reachable and the role may create/alter tables. Restore the last `pg_dump` before retrying a migration that partially applied. |
| Router exits at boot, cannot reach the database | `DATABASE_URL` wrong, or the `postgres` service unhealthy | `docker compose ps` shows the Postgres health state; `docker compose logs postgres` says why. With the bundled service the router waits for `pg_isready`, so this usually means a hand-edited `DATABASE_URL` or a managed instance rejecting the credentials/TLS mode. |
| Account shows a stale reset time — the window looks expired but the account is still skipped, or the provider clearly reset early | The stored reset came from the provider's reported value or a computed estimate, and providers do reset early, lift limits broadly, or restore a balance out of band. The router will not sit on its own clock forever, but it does not poll continuously either | Press **Re-check now** on `/accounts` (per account, or for all at once). It re-queries the provider's live quota signal, updates utilization and reset times, and returns the account to `active` immediately if it is healthy. The outcome shows inline with the time of the last check. Rate-limited per account by `ACCOUNT_RECHECK_COOLDOWN_SECONDS`. Note whether the displayed reset is labeled *reported* or *estimated* — an estimate was always a guess. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Claude subscription account fails every request while API-key accounts work | The `claude` CLI is missing or cannot exec in the image (a native binary built for a different libc), or `CLAUDE_CONFIG_ROOT` is not on the persistent volume | Read `checks.claudeCli` on `/readyz`: it names the resolution rung that won, or `missing`. The image stages the CLI from the SDK's own platform package and proves it execs at build time, so a custom build is the usual cause — keep builder and runtime on the same libc. Confirm the `claude-config` volume is mounted and owned by the container's uid — a fresh, empty config directory presents as an account that never authenticates. |
| All accounts `cooling_down`, requests fail | Every candidate hit a `429` or a circuit breaker and none has reset yet | Check reset times on `/accounts`. Add another account to the pool, or move the key to a pool with a paid-API fallback via `priority-failover`. See [05-routing-and-failover.md](05-routing-and-failover.md). |
| Clients get `401` | Key revoked, expired, wrong value, or both auth headers sent and disagreeing | Re-copy the key from `/keys`. Send exactly one of `Authorization: Bearer` or `x-api-key`. See [04-api-keys-and-access.md](04-api-keys-and-access.md). |
| Console login says it succeeded, then every screen bounces back to the login form ("session expired") | The router is reached over plain `http://` (a LAN install, or a proxy that does not forward `X-Forwarded-Proto`), so the browser silently discarded the `Secure` session cookie. The login itself was genuinely fine, which is why no status code names the problem | `docker compose logs router` carries a `warn` from the login itself: *"login succeeded but the session cookie is Secure and this request arrived over plain HTTP"*, with the remedy in the same line. Either set `SESSION_COOKIE_INSECURE=true` (plain-HTTP install), or terminate HTTPS in front and forward `X-Forwarded-Proto` — the header is honored for this check whether or not `TRUST_PROXY` is on. See [04-api-keys-and-access.md](04-api-keys-and-access.md#session-cookie). |
| A sweep hasn't run — the DB keeps growing, or usage rollups stop appearing | The scheduler runs in-process, so a wedged or crashed task is invisible unless you look at its last-run record | Check the task's last `ScheduledTaskRun` (admin UI, or the row directly): a stale `startedAt` with a null `finishedAt` means a run was killed halfway or is stuck holding the advisory lock; a stale `startedAt` with `outcome: failed` names the error. `outcome: partial` is normal and means the batch limit was hit and the next run continues. If every replica shows nothing, no replica is acquiring the lock — check Postgres connectivity and `JANITOR_INTERVAL_MINUTES`. |
| `/readyz` red, `/healthz` green | Postgres unreachable or zero healthy accounts | `/healthz` is liveness only, by design — zero healthy accounts is an operator problem, not a reason to restart a working process. Check `docker compose ps postgres` and account health. See [08-observability.md](08-observability.md). |
| `GET /metrics` returns `401` | `METRICS_TOKEN` is set and Prometheus (or your scrape client) is not sending it, or is sending it as the wrong header | `/metrics` has its own credential, separate from both the admin session and router keys — neither is accepted here. Send `Authorization: Bearer <METRICS_TOKEN>`. Leaving `METRICS_TOKEN` unset removes the check entirely; that is the intended posture for a single-host deployment where `/metrics` is not reachable outside its own network — see [08-observability.md](08-observability.md). |
| A revoked or edited router key still authenticates for a while, on some but not all replicas | Verified keys are cached in memory per process so verification does not round-trip Postgres on every request; admin revoke/edit calls `invalidate()` on the replica that served the request, and only on that one | Expected, bounded staleness: **invalidation is immediate on the serving replica, and every other replica keeps accepting the key for up to `KEY_CACHE_TTL_SECONDS` (60 seconds by default)** — that setting is the bound, so read it from your own environment rather than assuming the default. A revoked key stops working everywhere within that window with zero replica coordination, since a compromised key is not a reason to add a broker (non-negotiable: background work is in-process only, no Redis/pub-sub). If a key must be dead **immediately** on every replica, there is no faster path today than lowering the TTL — which costs a Postgres round-trip per uncached verification. See [04-api-keys-and-access.md](04-api-keys-and-access.md#verification-path). |

## Read next

| Doc | Covers |
|---|---|
| [07-security.md](07-security.md) | Encryption at rest, redaction, rate limits, threat framing |
| [08-observability.md](08-observability.md) | `/metrics`, `/healthz`, `/readyz`, structured logs |
| [10-roadmap.md](10-roadmap.md) | Milestones, deferrals, maintenance posture |
