import { isAbsolute } from "node:path"
import { UNKNOWN_REVISION } from "@multi-ai-router/core"
import { DATABASE_POOL_DEFAULTS } from "@multi-ai-router/db"
import { z } from "zod"
import { adminApiTokenProblem } from "../services/admin-auth"
import type { BoundCooldownBehavior } from "../services/routing"
import {
  absoluteUrl,
  atLeastOne,
  encryptionKey,
  flag,
  fraction,
  nonEmpty,
  usageBatchSize,
  wholeNumber,
} from "./fields"

/**
 * Boot-time environment validation — the reference is
 * docs/idea/09-deployment.md#environment-reference.
 *
 * `parseEnv` is pure: it never reads `process.env` itself, so it is unit-testable
 * and `main.ts` owns the single impure call. A failure names the offending
 * variable; boot exits non-zero rather than starting half-configured.
 *
 * Which parser a numeric variable takes is a decision, not a formality: `atLeastOne` where zero
 * would stop a mechanism without saying so, `wholeNumber` only where zero is a setting an
 * operator could mean. `fields.ts` states the rule and lists the exceptions; a drift guard holds
 * this schema to it.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const
export type LogLevel = (typeof LOG_LEVELS)[number]

/**
 * The four knobs an OIDC admin login needs at boot. The router does not
 * implement the protocol itself — it relies on the IdP's discovery document
 * for the endpoint URLs — so the configuration here is the *identity* of the
 * issuer and the *principal* we are willing to admit. The IdP is the source of
 * truth for everything else.
 *
 * `adminSubject` is optional: the `email` is the primary check, and the
 * `sub` is the optional stricter one. Pinning subject matters when the IdP
 * reuses emails across tenants; the operator who needs that can set it.
 */
export interface AdminOidcConfig {
  /** Exactly the issuer URL. Compared with the discovery doc and `id_token.iss`. */
  readonly issuerUrl: string
  /** The OAuth client id the router registered with the IdP. */
  readonly clientId: string
  /** The OAuth client secret. Null for a public client. */
  readonly clientSecret: string | null
  /** The redirect URI the IdP will return the browser to. */
  readonly redirectUri: string
  /**
   * The emails the IdP may assert for the admin to be admitted, lowercased and
   * deduplicated at parse time. Never empty when this config exists.
   *
   * A list rather than one string because a self-hosted router is normally run
   * by a *team* — every operator has their own IdP identity, and pinning one
   * email means everyone else shares a credential or nobody else gets in. This
   * is **not** multi-user: there are no user rows, no roles and no per-person
   * state. Every entry maps onto the same single admin principal and the same
   * session model, exactly as the single email did.
   */
  readonly adminEmails: readonly string[]
  /** Optional stricter: the `sub` claim must equal this value. */
  readonly adminSubject: string | null
  /**
   * Scopes to request. `openid` is mandatory; everything else is passed
   * through to the IdP. Defaults to `openid profile email`.
   */
  readonly scopes: readonly string[]
  /** Maximum tolerated clock skew between the router and the IdP, in seconds. */
  readonly clockSkewSeconds: number
}

export interface RetentionConfig {
  readonly sessionsHours: number
  readonly usageDays: number
  /**
   * How long the *daily aggregates* are kept — the long half of the two-tier retention the rollup
   * exists for, and necessarily wider than {@link RetentionConfig.usageDays}: a window narrower
   * than the raw one would have the janitor delete days the rollup re-inserts on its very next
   * tick, forever. Boot refuses that rather than letting the two sweeps fight.
   */
  readonly usageDailyDays: number
  readonly auditDays: number
  /** How long a *finished* scheduled-task run is kept. An unfinished one is never swept. */
  readonly taskRunsDays: number
  readonly revokedKeysDays: number
  readonly oauthStateMinutes: number
  /**
   * How long a `CLAUDE_CONFIG_DIR` under `CLAUDE_CONFIG_ROOT` that no account claims is kept before
   * the reaper removes it. A grace, not a schedule: a directory is provisioned *before* its account
   * row is inserted, so anything shorter than the widest gap between those two would delete a
   * directory an account is about to name (`scheduler/tasks/config-dir-reap.ts`).
   */
  readonly orphanConfigDirHours: number
}

/**
 * The Postgres connection pool — one pool, shared by everything that is not the request path.
 *
 * Nothing here is reachable from a client request (non-negotiable 8 keeps Postgres off the hot
 * path), which is exactly why the ceiling matters: the admin console, every scheduler sweep, the
 * off-path usage/quota/status writers and `/readyz` all queue behind the same `maxConnections`.
 * A pool sized for one router is wrong for a deployment running four replicas against a managed
 * instance with a connection cap, or for one whose sweeps run long — so it is config, not a
 * constant (non-negotiable 11).
 *
 * The three timeouts are seconds because postgres.js counts in seconds. Two of them accept `0`
 * and it does not mean "immediately": postgres.js treats a falsy interval as a timer that never
 * fires, so `0` reads as *never* — `fields.ts` records which.
 *
 * Defaults come from `DATABASE_POOL_DEFAULTS` in `@multi-ai-router/db`, so an unset variable and
 * one set to the documented default are the same value, not two that happen to agree.
 */
export interface DatabasePoolConfig {
  /** Connections this replica may hold open at once. */
  readonly maxConnections: number
  /** How long an idle connection is kept. `0` keeps it forever. */
  readonly idleTimeoutSeconds: number
  /** How long a dial waits to be accepted before it fails. */
  readonly connectTimeoutSeconds: number
  /** Age at which a connection is recycled, so a rolling failover drains cleanly. `0` never recycles. */
  readonly maxLifetimeSeconds: number
  /**
   * How long the shutdown's pool close waits for in-flight queries before destroying them.
   *
   * The last step of a shutdown that is already racing the orchestrator's kill, so it is bounded
   * for the same reason `SHUTDOWN_DRAIN_MS` is: an unbounded wait here hands the exit to a
   * `SIGKILL`. `0` destroys the pool at once.
   */
  readonly closeTimeoutSeconds: number
}

/**
 * Admin-plane session policy: the login-throttle windows, and the one transport
 * decision the session cookie cannot make for itself. Grouped like
 * `RetentionConfig` rather than flattened onto `Env`, because they are one
 * policy read by one consumer (`services/admin-auth`).
 *
 * All six are optional: the documented happy path stays three hand-set
 * variables plus `docker compose up`.
 *
 * Deliberately NOT `retention.sessionsHours` — that is the *conversation*
 * sticky-session TTL for routing, a different thing that merely shares a word.
 */
export interface AdminAuthConfig {
  /** Sliding idle window; also the session cookie's `Max-Age`. */
  readonly sessionIdleMinutes: number
  /** Hard cap on total session life regardless of activity. A purely sliding session is one a thief renews forever. */
  readonly sessionAbsoluteHours: number
  /** Failed logins per throttle key before it locks. */
  readonly loginMaxAttempts: number
  /** Failures older than this stop counting toward the lock. */
  readonly loginAttemptWindowMinutes: number
  /** How long a tripped throttle key stays locked. */
  readonly loginLockoutMinutes: number
  /**
   * Share of the idle window a session must have advanced before the slide persists to the
   * store. `0.1` of an 8-hour idle window is ~48 minutes: an operator clicking around gets one
   * store write roughly every that often instead of one per request — see
   * `services/admin-auth/service.ts`.
   */
  readonly sessionSlideFraction: number
  /**
   * Drops `Secure` and the `__Host-` prefix from the session cookie. Off by
   * default and warned about at boot: it is the escape hatch for a plain-HTTP
   * LAN install (`http://192.168.1.50:8080`), where the hardened cookie is
   * discarded by the browser and login fails with nothing explaining why.
   * `HttpOnly`, `SameSite=Strict` and the CSRF token are unaffected — see
   * `services/admin-auth/cookies.ts`.
   */
  readonly sessionCookieInsecure: boolean
  /**
   * `ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC`. Opts out of the fail-closed rule that
   * refuses to boot when a local admin password exists and `PUBLIC_URL` is not
   * loopback (`services/admin-auth/boot.ts`). Off by default; setting it is the
   * operator stating by name that a password-only door on a public address is
   * acceptable to them, and boot warns about it every time.
   */
  readonly localLoginAllowPublic: boolean
}

/**
 * The knobs on the request path's two in-memory caches and its off-path writer.
 *
 * Every one of these is a staleness or memory bound that an operator running a
 * large pool may legitimately want to move, which is why none of them is a
 * constant in code (CLAUDE.md non-negotiable 11).
 */
export interface DataPlaneConfig {
  /**
   * How long the warm routing catalog may lag a write made by *another* replica.
   * A write by this replica refreshes it immediately, so this bounds only the
   * multi-replica case.
   */
  readonly catalogRefreshSeconds: number
  /** Verified router keys held in memory. The ceiling is memory, not correctness. */
  readonly keyCacheMax: number
  /** How long a successful key verification is reused. Revocation invalidates immediately. */
  readonly keyCacheTtlSeconds: number
  /**
   * How long a *failed* lookup is remembered. Short on purpose: this is what
   * stops a flood of bad keys from becoming a flood of queries, and a key that
   * was just minted must start working quickly.
   */
  readonly keyCacheNegativeTtlSeconds: number
  /** Session -> Account bindings held in memory, plus their fingerprint aliases. */
  readonly sessionCacheMax: number
  /**
   * How long a binding is reused before its row is re-read. It bounds only how long this replica
   * may lag another one's rebind; the row itself never expires, because an SDK session outlives
   * any cache and dropping the mapping forces a destructive replay.
   */
  readonly sessionCacheTtlSeconds: number
  /**
   * How long "this session has no binding" is remembered. Short, and for the opposite reason to
   * the key cache's: it is what keeps plain HTTP traffic on a subscription-serving router from
   * re-asking Postgres every request, while still letting a binding minted elsewhere show up.
   */
  readonly sessionCacheNegativeTtlSeconds: number
  /** Usage records held in memory before the writer sheds the oldest. Reporting degrades; traffic does not. */
  readonly usageQueueMax: number
  /**
   * Rows per insert. Validated into `1..USAGE_RECORD_MAX_BATCH_ROWS` at boot — outside that
   * range every flush loses its whole batch and reporting goes silently empty.
   */
  readonly usageBatchSize: number
  readonly usageFlushIntervalMs: number
  /**
   * How long an observed quota reading may sit in this replica's memory before it is persisted.
   *
   * Not a poll: a reading only exists after a response reported one, and the writer flushes what
   * arrived. The interval bounds how much of a running process's quota state a hard kill loses —
   * and how stale the console's gauges are on the replica that did *not* serve the request.
   */
  readonly quotaWriteIntervalMs: number
  /**
   * How long a standing block the breaker just formed — `exhausted`, `needs_reauth` — may sit in
   * this replica's memory before it is written through to `accounts.status`.
   *
   * Not a poll either, and shorter than the quota interval by default because what it bounds is
   * different: a lost quota reading costs a stale gauge, a lost standing block costs the operator
   * the banner telling them an account needs topping up. Routing is unaffected at any setting —
   * the breaker holds the verdict either way.
   */
  readonly accountStatusWriteIntervalMs: number
  /**
   * The largest request body the router will read, in bytes. Over it: `413`, before any account is
   * asked and before the ceiling's worth of bytes has been buffered.
   *
   * A property of the deployment, not of the code: a router fronting agents that paste whole
   * repositories into a prompt needs a different number from one serving chat, and the memory this
   * bounds is per in-flight request.
   */
  readonly maxRequestBodyBytes: number
}

/**
 * How hard the router tries before it gives up, and how long a failing account stays out.
 *
 * These are the knobs an operator reaches for when their pool's shape does not match the
 * defaults — a two-account deployment wants a different attempt cap than a twenty-account one,
 * and a provider with a slow recovery wants a longer backoff ceiling.
 *
 * One thing no value here can change: **an attempt is never retried after bytes are on the
 * wire.** That is a correctness rule, not a tuning parameter (CLAUDE.md, "Retry a request onto
 * another account after bytes are on the wire — fail honestly").
 */
export interface FailoverConfig {
  /** Distinct accounts tried for one client request, before the honest failure. */
  readonly maxAttempts: number
  /** Consecutive 5xx or connection failures before an account's breaker trips. */
  readonly failureThreshold: number
  /** First cooldown step. Doubles per consecutive failure. */
  readonly baseBackoffMs: number
  /** Ceiling on that doubling, so a long outage does not park an account for hours. */
  readonly maxBackoffMs: number
  /**
   * How long the one admitted half-open probe holds a recovering account before the gate reopens.
   *
   * A backstop for a probe that never reports — the chain releases the hold the instant its attempt
   * reaches a verdict. While it is held, every other request is told `429` with this instant rather
   * than being dispatched onto an account that has answered nobody yet.
   */
  readonly halfOpenHoldMs: number
  /** How long the router waits on one upstream. Long, because a long completion is normal. */
  readonly upstreamTimeoutMs: number
  /**
   * What a request does when its session is bound to an account that is merely cooling down.
   *
   * `fail` (default) answers the honest `429` with a `Retry-After` and keeps the binding — the
   * conversation stays resumable on the account that owns it. `rebind` invalidates the binding
   * instead and starts a fresh upstream session on another eligible account: the request is
   * served now rather than after the reset, at the cost of the prior turns the bound account
   * still holds. Opt-in, because the loss of those turns is real even though it is surfaced —
   * see `services/routing/binding.ts`.
   */
  readonly boundAccountCoolingDown: BoundCooldownBehavior
}

/**
 * Scheduler task intervals and tuning.
 *
 * Every interval is config, never a constant in code (CLAUDE.md non-negotiable 11).
 * The actual interval is jittered around the configured value so sweeps never pile
 * onto request spikes or onto each other after a restart.
 */
export interface SchedulerConfig {
  /** Usage record rollup interval, in minutes. */
  readonly usageRollupIntervalMinutes: number
  /** OAuth state (and PKCE verifier) purge interval, in minutes. */
  readonly oauthStatePurgeIntervalMinutes: number
  /** Account quota floor probe interval, in minutes. */
  readonly quotaFloorIntervalMinutes: number
  /** Orphaned `CLAUDE_CONFIG_DIR` reap interval, in minutes. The window itself is `retention`. */
  readonly configDirReapIntervalMinutes: number
  /**
   * Admin console session purge interval, in minutes. Sweeps the in-memory `SessionStore`, not a
   * table, so every replica runs it against its own heap — see `scheduler/tasks/admin-session-purge.ts`.
   */
  readonly adminSessionPurgeIntervalMinutes: number
  /**
   * How often the idle-account keepalive sweep looks for accounts traffic has forgotten. Daily by
   * default — the *cadence per account* is set by `idleAccountAfterDays`, not by this, because a
   * probed account stops being idle until that threshold passes again.
   */
  readonly idleAccountProbeIntervalMinutes: number
  /**
   * How long an account must have gone unused before one real, billed request is spent keeping it
   * alive. Default 7 days, comfortably inside a Claude subscription's ~4-week refresh-token life:
   * the SDK refreshes those tokens only when it runs, so an account nobody routes to expires
   * silently and fails at exactly the moment it is next needed
   * (`scheduler/tasks/idle-account-probe.ts`).
   *
   * Raising it past the shortest refresh-token life among the connected accounts re-opens that
   * hole; lowering it costs one request per account per window.
   */
  readonly idleAccountAfterDays: number
  /**
   * Accounts probed per keepalive tick. Small on purpose and separate from `sweepBatchSize`: each
   * item may spawn a ~245 MB `claude` subprocess and bill a turn, which is nothing like deleting a
   * row. The sweep is resumable, so a backlog drains over consecutive ticks.
   */
  readonly idleAccountProbeBatchSize: number
  /**
   * How often the model catalog is re-read from each account's upstream. Hourly by default, which
   * it can afford to be: a model listing costs no tokens and spends no quota window, unlike the
   * keepalive above. It writes only `model_catalog` — a description nothing in routing reads — so
   * an upstream retiring a model changes what the listing *says* and never where a request lands.
   */
  readonly modelCatalogRefreshIntervalMinutes: number
  /**
   * Accounts refreshed per catalog tick. Bounds outbound requests per tick, not memory. The sweep
   * orders by staleness, so a deployment with more accounts than one batch rotates through them
   * across consecutive ticks rather than refreshing the same few forever.
   */
  readonly modelCatalogRefreshBatchSize: number
  /** Max rows per bounded-delete sweep. */
  readonly sweepBatchSize: number
  /** Jitter applied to task intervals as a fraction of the interval. E.g., 0.2 means ±20%. */
  readonly jitterFraction: number
}

/**
 * Router-held OAuth token refresh. Per-account and expiry-driven, so none of these is an interval:
 * they shape a schedule each account's own token dictates — `services/accounts/refresh/`.
 *
 * Claude subscriptions are untouched by every value here. Their tokens live in a `CLAUDE_CONFIG_DIR`
 * the Agent SDK owns and the router never schedules a refresh for one (non-negotiable 1).
 */
export interface OAuthRefreshConfig {
  /** Share of a token's remaining lifetime allowed to elapse first. `0.75` leaves a quarter. */
  readonly leadFraction: number
  /** Floor on any refresh delay, and the first step of the retry backoff. Never zero. */
  readonly minDelaySeconds: number
  /** Unreachable-issuer attempts before the account is parked. A refusal is never retried. */
  readonly maxAttempts: number
}

/** Cross-dialect translation tuning. A ceiling an operator lives with is config, never code. */
export interface TranslationConfig {
  /**
   * The `max_tokens` an Anthropic egress is given when the client's dialect made it optional and
   * the client omitted it. Deliberately generous: a low value truncates an answer the caller never
   * asked to truncate, which is the one failure a default must not cause silently.
   */
  readonly defaultMaxTokens: number
}

export interface Env {
  readonly port: number
  /**
   * How long a shutdown lets in-flight requests finish before closing what is left.
   *
   * A streaming completion is a request that legitimately runs for minutes, and `Bun.serve().stop()`
   * waits for the last one of them without a bound — so this is the bound. It must stay comfortably
   * *under* the orchestrator's own kill grace (`stop_grace_period` in the bundled compose file,
   * `terminationGracePeriodSeconds` on Kubernetes), because everything the flush behind it writes —
   * usage rows, quota readings, standing blocks — is lost to a `SIGKILL` that lands first.
   * `0` closes in-flight responses immediately. See `services/shutdown/drain.ts`.
   */
  readonly shutdownDrainMs: number
  /**
   * How long the router keeps serving *after* `/readyz` starts refusing and *before* the listener
   * closes — the window a load balancer has to notice and stop sending it work.
   *
   * Without it the readiness flip is nearly inert, and that is measured, not assumed: once
   * `Bun.serve().stop()` is called the listener refuses new connections *and* stops dispatching on
   * the keep-alive connections it already had, so the honest `503` has nobody left to tell. This
   * window is when it can be told.
   *
   * `0` — the default — closes the listener at once, which is right for the bundled compose
   * deployment: nothing there polls readiness, so the wait would be pure added shutdown time. A
   * Kubernetes deployment wants roughly two readiness periods here (`periodSeconds`, default 10s),
   * and its `terminationGracePeriodSeconds` has to cover this *plus* `SHUTDOWN_DRAIN_MS`.
   */
  readonly shutdownReadyGraceMs: number
  readonly databaseUrl: string
  readonly databasePool: DatabasePoolConfig
  /**
   * The OIDC relying-party configuration, or null when no `ADMIN_OIDC_*`
   * variable is set at all. Null is only viable alongside a local admin
   * credential (`bin/admin set-password`): "OIDC or local" needs the database,
   * so that half of the rule is checked after migrations
   * (`services/admin-auth/boot.ts`); this parser owns the other half — a
   * *partial* OIDC block fails here, immediately, naming the missing fields.
   */
  readonly adminOidc: AdminOidcConfig | null
  readonly encryptionKey: string
  readonly logLevel: LogLevel
  readonly trustProxy: boolean
  readonly publicUrl: string | null
  /**
   * Which commit this build is, for `router_build_info{revision}` and the boot log. Stamped into
   * the released image from the tagged commit's sha; `UNKNOWN_REVISION` for anything nobody
   * stamped. Never validated as a sha — a caller may legitimately stamp a build number instead,
   * and refusing an operator's own label would buy nothing.
   */
  readonly revision: string
  /**
   * Directory holding the built admin SPA, which this process serves at the root. Null means the
   * default location beside the bundled entrypoint — `main.ts` resolves it, because only it knows
   * where this module was loaded from. Set means *exactly this*: a directory with no `index.html`
   * fails boot rather than quietly serving an API-only router that looks like a broken web app.
   */
  readonly webRoot: string | null
  /** Parent of the per-Account `CLAUDE_CONFIG_DIR`s — `providers/claude-sdk/config-dir.ts`. */
  readonly claudeConfigRoot: string
  /**
   * Pins the `claude` binary the Agent SDK spawns, bypassing the resolution ladder. Set means
   * *exactly this*: an unusable path fails rather than falling through to some other binary the
   * operator did not name — `providers/claude-sdk/resolve-cli.ts`.
   */
  readonly claudeCliPath: string | null
  /**
   * `claude` subprocesses in flight on this replica — every `query()` spawns a ~245 MB native
   * binary (measured, see docs/idea/09-deployment.md#sizing), so this is a memory bound, not a
   * throughput one. Excess requests queue rather than fail. The per-account ceiling is what stops
   * one Account's burst starving the pool.
   */
  readonly claudeSdkMaxConcurrency: number
  readonly claudeSdkMaxConcurrencyPerAccount: number
  /**
   * Bearer token `GET /metrics` demands, or null to leave it open. Null is the right default for
   * a deployment whose metrics port is not routable; see `routes/metrics.ts`.
   */
  readonly metricsToken: string | null
  /**
   * Bearer token that authenticates `/api/admin/**` without a browser login, or null to leave the
   * admin plane browser-only. Null is the default and the conservative one — this adds a
   * credential rather than enabling one (`services/admin-auth/apiToken.ts`).
   */
  readonly adminApiToken: string | null
  /**
   * GlitchTip (Sentry-protocol) DSN the router ships errors to, or null to leave error tracking
   * off. Null is the default — a dev, test or CI boot ships nothing. In production a sealed
   * `SENTRY_DSN` turns it on; see `observability/sentry.ts` for the redaction that makes that safe.
   */
  readonly sentryDsn: string | null
  /**
   * Logical environment tagged on every event ("production", "staging"); GlitchTip groups and
   * filters on it. Defaults to "production"; override with `SENTRY_ENVIRONMENT` for a staging or
   * dev install that also carries a DSN.
   */
  readonly sentryEnvironment: string
  readonly accountRecheckCooldownSeconds: number
  /**
   * "Test now"'s own cooldown — deliberately not shared with `accountRecheckCooldownSeconds`. A
   * re-check is free and clears breaker marks; a test sends a real, billed request (an Agent-SDK
   * one spawns a subprocess and spends a turn), so pressing one must never consume the other's
   * window (`services/accounts/test-now.ts`).
   */
  readonly accountTestNowCooldownSeconds: number
  readonly retention: RetentionConfig
  readonly janitorIntervalMinutes: number
  readonly adminAuth: AdminAuthConfig
  readonly dataPlane: DataPlaneConfig
  readonly failover: FailoverConfig
  readonly scheduler: SchedulerConfig
  readonly oauthRefresh: OAuthRefreshConfig
  readonly translation: TranslationConfig
}

/**
 * Boot configuration failure. Deliberately not a `RouterError` from
 * `@multi-ai-router/core`: those map to an HTTP status, and this one never
 * becomes a response — the process exits before the listener opens.
 */
export class EnvValidationError extends Error {
  readonly variables: readonly string[]

  constructor(message: string, variables: readonly string[]) {
    super(message)
    this.name = "EnvValidationError"
    this.variables = variables
  }
}

// Re-exported so a caller that already depends on this module for `Env` does not have to learn
// where the field vocabulary moved to.
export { decodeEncryptionKey, ZERO_IS_LEGAL } from "./fields"

/**
 * Every variable this module parses, deliberately kept as a flat list of names and parsers: the
 * *reason* a given knob is bounded the way it is belongs in
 * docs/idea/09-deployment.md#environment-reference, which is where an operator reading the error
 * message will go, and restating it here is how the two start to disagree.
 *
 * Which parser each numeric field takes is not free choice — `fields.ts` states the rule and
 * `ZERO_IS_LEGAL` lists its exceptions. Exported as the shape rather than only as the built
 * schema so the drift guard in `test/unit/env.test.ts` can walk it field by field and refuse a
 * numeric knob that is neither bounded nor explained. Adding one below is therefore a decision
 * about zero, whether or not anyone remembered to make one.
 */
export const ENV_FIELDS = {
  PORT: wholeNumber.optional(),
  SHUTDOWN_DRAIN_MS: wholeNumber.optional(),
  SHUTDOWN_READY_GRACE_MS: wholeNumber.optional(),
  DATABASE_URL: nonEmpty,
  DB_POOL_MAX: atLeastOne.optional(),
  DB_POOL_IDLE_TIMEOUT_SECONDS: wholeNumber.optional(),
  DB_POOL_CONNECT_TIMEOUT_SECONDS: atLeastOne.optional(),
  DB_POOL_MAX_LIFETIME_SECONDS: wholeNumber.optional(),
  DB_POOL_CLOSE_TIMEOUT_SECONDS: wholeNumber.optional(),
  // === Admin OIDC ===
  // One of two ways to obtain an admin session — the other is the local admin
  // password (`bin/admin set-password`, an argon2id hash in Postgres). The four
  // fields below are all-or-nothing: all absent means "OIDC off, local login
  // only" and is legal here, because "OIDC or local" needs the database and is
  // therefore checked after migrations (`services/admin-auth/boot.ts`). A
  // *partial* block is an operator mistake and fails fast, with a message
  // pointing at docs/idea/13-admin-oidc.md.
  //
  // The required fields are parsed as optional so the `.transform` step can
  // raise a single, doc-pointing message for every missing field rather than
  // the per-field "is required" line `nonEmpty` would otherwise emit. The
  // `nonEmpty` would win on first write because `toEnvValidationError` keeps
  // only the first issue per path, which is the wrong ordering for a doc
  // pointer.
  ADMIN_OIDC_ISSUER_URL: z.string().optional(),
  ADMIN_OIDC_CLIENT_ID: z.string().optional(),
  ADMIN_OIDC_CLIENT_SECRET: z.string().optional(),
  ADMIN_OIDC_REDIRECT_URI: z.string().optional(),
  ADMIN_OIDC_ADMIN_EMAIL: z.string().optional(),
  ADMIN_OIDC_ADMIN_SUBJECT: z.string().optional(),
  ADMIN_OIDC_SCOPES: z.string().optional(),
  ADMIN_OIDC_CLOCK_SKEW_SECONDS: atLeastOne.optional(),
  // The named opt-out of the fail-closed loopback rule for the local admin
  // password — see `services/admin-auth/boot.ts`. Off by default, on purpose.
  ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC: flag.optional(),
  ENCRYPTION_KEY: encryptionKey,
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  TRUST_PROXY: flag.optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  PUBLIC_URL: absoluteUrl.optional(),
  ROUTER_REVISION: nonEmpty.optional(),
  WEB_ROOT: nonEmpty.optional(),
  CLAUDE_CONFIG_ROOT: nonEmpty.refine(isAbsolute, "must be an absolute path").optional(),
  CLAUDE_CLI_PATH: nonEmpty.optional(),
  CLAUDE_SDK_MAX_CONCURRENCY: atLeastOne.optional(),
  CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT: atLeastOne.optional(),
  METRICS_TOKEN: nonEmpty.optional(),
  // Refused by name at boot when too short to resist guessing, or when it wears the router-key
  // prefix — the admin guard rejects that prefix outright, so such a token would authenticate
  // nothing and look correct while doing it. Both rules live in `admin-auth/apiToken.ts`.
  ADMIN_API_TOKEN: nonEmpty
    .superRefine((value, ctx) => {
      const problem = adminApiTokenProblem(value)
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem })
    })
    .optional(),
  ACCOUNT_RECHECK_COOLDOWN_SECONDS: wholeNumber.optional(),
  ACCOUNT_TEST_NOW_COOLDOWN_SECONDS: wholeNumber.optional(),
  RETENTION_SESSIONS_HOURS: atLeastOne.optional(),
  RETENTION_USAGE_DAYS: atLeastOne.optional(),
  RETENTION_USAGE_DAILY_DAYS: atLeastOne.optional(),
  RETENTION_AUDIT_DAYS: atLeastOne.optional(),
  RETENTION_TASK_RUNS_DAYS: atLeastOne.optional(),
  RETENTION_REVOKED_KEYS_DAYS: atLeastOne.optional(),
  RETENTION_OAUTH_STATE_MINUTES: atLeastOne.optional(),
  RETENTION_ORPHAN_CONFIG_DIR_HOURS: atLeastOne.optional(),
  JANITOR_INTERVAL_MINUTES: atLeastOne.optional(),
  USAGE_ROLLUP_INTERVAL_MINUTES: atLeastOne.optional(),
  OAUTH_STATE_PURGE_INTERVAL_MINUTES: atLeastOne.optional(),
  QUOTA_FLOOR_INTERVAL_MINUTES: atLeastOne.optional(),
  CONFIG_DIR_REAP_INTERVAL_MINUTES: atLeastOne.optional(),
  // Both refuse 0: an interval of zero re-arms every millisecond, and a threshold of zero makes
  // every account idle, so the sweep would bill a request per account per tick, forever.
  IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES: atLeastOne.optional(),
  IDLE_ACCOUNT_AFTER_DAYS: atLeastOne.optional(),
  IDLE_ACCOUNT_PROBE_BATCH_SIZE: atLeastOne.optional(),
  ADMIN_SESSION_PURGE_INTERVAL_MINUTES: atLeastOne.optional(),
  MODEL_CATALOG_REFRESH_INTERVAL_MINUTES: atLeastOne.optional(),
  MODEL_CATALOG_REFRESH_BATCH_SIZE: atLeastOne.optional(),
  SWEEP_BATCH_SIZE: atLeastOne.optional(),
  SCHEDULER_JITTER_FRACTION: fraction.optional(),
  // Exclusive bounds: `0` would refresh in a loop and `1` would refresh at the instant of
  // expiry, so both are misconfigurations rather than extreme-but-valid settings.
  // The one field whose bounds are not the shared `fraction`'s: `0` would refresh in a loop and
  // `1` would refresh at the instant of expiry, so both ends are excluded rather than clamped.
  OAUTH_REFRESH_LEAD_FRACTION: fraction
    .refine((v) => v > 0 && v < 1, "must be between 0 and 1, exclusive")
    .optional(),
  OAUTH_REFRESH_MIN_DELAY_SECONDS: atLeastOne.optional(),
  OAUTH_REFRESH_MAX_ATTEMPTS: atLeastOne.optional(),
  ADMIN_SESSION_IDLE_MINUTES: atLeastOne.optional(),
  ADMIN_SESSION_ABSOLUTE_HOURS: atLeastOne.optional(),
  ADMIN_LOGIN_MAX_ATTEMPTS: atLeastOne.optional(),
  ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: atLeastOne.optional(),
  ADMIN_LOGIN_LOCKOUT_MINUTES: atLeastOne.optional(),
  ADMIN_SESSION_SLIDE_FRACTION: fraction.optional(),
  SESSION_COOKIE_INSECURE: flag.optional(),
  CATALOG_REFRESH_SECONDS: atLeastOne.optional(),
  KEY_CACHE_MAX: atLeastOne.optional(),
  KEY_CACHE_TTL_SECONDS: atLeastOne.optional(),
  KEY_CACHE_NEGATIVE_TTL_SECONDS: wholeNumber.optional(),
  SESSION_CACHE_MAX: atLeastOne.optional(),
  SESSION_CACHE_TTL_SECONDS: atLeastOne.optional(),
  SESSION_CACHE_NEGATIVE_TTL_SECONDS: wholeNumber.optional(),
  USAGE_QUEUE_MAX: atLeastOne.optional(),
  USAGE_BATCH_SIZE: usageBatchSize.optional(),
  USAGE_FLUSH_INTERVAL_MS: atLeastOne.optional(),
  QUOTA_WRITE_INTERVAL_MS: atLeastOne.optional(),
  ACCOUNT_STATUS_WRITE_INTERVAL_MS: atLeastOne.optional(),
  MAX_REQUEST_BODY_BYTES: atLeastOne.optional(),
  ROUTING_MAX_ATTEMPTS: atLeastOne.optional(),
  ROUTING_FAILURE_THRESHOLD: atLeastOne.optional(),
  ROUTING_BASE_BACKOFF_MS: atLeastOne.optional(),
  ROUTING_MAX_BACKOFF_MS: atLeastOne.optional(),
  ROUTING_HALF_OPEN_HOLD_MS: atLeastOne.optional(),
  // `fail` keeps a bound session on its cooling-down account and answers 429; `rebind` drops the
  // binding and starts the conversation fresh on another eligible account. Enum, not a number —
  // the drift guard's zero rule does not apply.
  ROUTING_BOUND_ACCOUNT_COOLING_DOWN: z.enum(["fail", "rebind"]).optional(),
  UPSTREAM_TIMEOUT_MS: atLeastOne.optional(),
  TRANSLATE_DEFAULT_MAX_TOKENS: atLeastOne.optional(),
} as const

const envSchema = z.object(ENV_FIELDS).transform((raw, ctx): Env => {
  // OIDC is all-or-nothing at parse time. All four absent means "local login
  // only", which is legal — whether *some* sign-in method exists is decided
  // after migrations, because the local credential's existence is a row in the
  // database (`services/admin-auth/boot.ts`). A partial block is neither and
  // fails here, naming every missing field and pointing at the doc.
  const requiredOidc: ReadonlyArray<{ key: keyof typeof raw; env: string }> = [
    { key: "ADMIN_OIDC_ISSUER_URL", env: "ADMIN_OIDC_ISSUER_URL" },
    { key: "ADMIN_OIDC_CLIENT_ID", env: "ADMIN_OIDC_CLIENT_ID" },
    { key: "ADMIN_OIDC_REDIRECT_URI", env: "ADMIN_OIDC_REDIRECT_URI" },
    { key: "ADMIN_OIDC_ADMIN_EMAIL", env: "ADMIN_OIDC_ADMIN_EMAIL" },
  ]
  const missingOidc: string[] = []
  for (const { key, env } of requiredOidc) {
    const value = raw[key]
    if (typeof value !== "string" || value.length === 0) missingOidc.push(env)
  }
  const oidcConfigured = missingOidc.length === 0
  if (!oidcConfigured && missingOidc.length < requiredOidc.length) {
    for (const env of missingOidc) {
      ctx.addIssue({
        code: "custom",
        path: [env],
        message: `is required once any ADMIN_OIDC_* variable is set — see docs/idea/13-admin-oidc.md`,
      })
    }
    return z.NEVER
  }

  // Comma-separated, so one operator per entry. Lowercased here rather than at the comparison so
  // the flow compares two already-normalized values, and deduplicated so a repeated entry cannot
  // make the allowlist look longer than the number of humans it admits. A value that parses to
  // *zero* emails (`","`, `" "`) is an operator mistake that would otherwise configure OIDC with
  // an allowlist nobody can satisfy — every login would fail the principal check, which reads as a
  // broken IdP rather than a typo here.
  const adminEmails = oidcConfigured
    ? [
        ...new Set(
          (raw.ADMIN_OIDC_ADMIN_EMAIL as string)
            .split(",")
            .map((entry) => entry.trim().toLowerCase())
            .filter((entry) => entry.length > 0),
        ),
      ]
    : []
  if (oidcConfigured && adminEmails.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["ADMIN_OIDC_ADMIN_EMAIL"],
      message: `must name at least one email — see docs/idea/13-admin-oidc.md`,
    })
    return z.NEVER
  }

  const adminOidc: AdminOidcConfig | null = oidcConfigured
    ? {
        issuerUrl: raw.ADMIN_OIDC_ISSUER_URL as string,
        clientId: raw.ADMIN_OIDC_CLIENT_ID as string,
        clientSecret: raw.ADMIN_OIDC_CLIENT_SECRET ?? null,
        redirectUri: raw.ADMIN_OIDC_REDIRECT_URI as string,
        adminEmails,
        adminSubject: raw.ADMIN_OIDC_ADMIN_SUBJECT ?? null,
        scopes: (raw.ADMIN_OIDC_SCOPES ?? "openid profile email").split(/\s+/u).filter(Boolean),
        clockSkewSeconds: raw.ADMIN_OIDC_CLOCK_SKEW_SECONDS ?? 60,
      }
    : null

  const usageDays = raw.RETENTION_USAGE_DAYS ?? 90
  // Two years of daily aggregates: long enough that "what did this cost me last year" is still
  // answerable, and the first bound this table has ever had.
  const usageDailyDays = raw.RETENTION_USAGE_DAILY_DAYS ?? 730
  if (usageDailyDays < usageDays) {
    // Not clamped, because either value could be the one the operator meant and guessing which
    // silently discards history. The two sweeps would otherwise fight forever: the janitor deletes
    // a rolled day, the rollup re-inserts it on the next tick because its raw rows are still there.
    ctx.addIssue({
      code: "custom",
      path: ["RETENTION_USAGE_DAILY_DAYS"],
      message:
        `must be at least RETENTION_USAGE_DAYS (${usageDays}): daily aggregates are the long ` +
        `half of usage retention, and a shorter window would delete days the rollup immediately ` +
        `writes back`,
    })
    return z.NEVER
  }

  return {
    port: raw.PORT ?? 8080,
    // Fifteen seconds: long enough for the ordinary streamed answer in flight at deploy time to
    // land, short enough to leave the flush room inside the 30s stop grace the bundled compose
    // file declares. Neither number is a guess the other has to match by luck — an image-pins
    // test holds the compose grace above this default.
    shutdownDrainMs: raw.SHUTDOWN_DRAIN_MS ?? 15_000,
    // Zero, so the bundled compose deployment shuts down exactly as fast as it used to: nothing
    // there polls readiness, so the window would buy an operator nothing and cost them seconds.
    shutdownReadyGraceMs: raw.SHUTDOWN_READY_GRACE_MS ?? 0,
    databaseUrl: raw.DATABASE_URL,
    databasePool: {
      maxConnections: raw.DB_POOL_MAX ?? DATABASE_POOL_DEFAULTS.maxConnections,
      idleTimeoutSeconds:
        raw.DB_POOL_IDLE_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.idleTimeoutSeconds,
      connectTimeoutSeconds:
        raw.DB_POOL_CONNECT_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.connectTimeoutSeconds,
      maxLifetimeSeconds:
        raw.DB_POOL_MAX_LIFETIME_SECONDS ?? DATABASE_POOL_DEFAULTS.maxLifetimeSeconds,
      closeTimeoutSeconds:
        raw.DB_POOL_CLOSE_TIMEOUT_SECONDS ?? DATABASE_POOL_DEFAULTS.closeTimeoutSeconds,
    },
    adminOidc,
    encryptionKey: raw.ENCRYPTION_KEY,
    logLevel: raw.LOG_LEVEL ?? "info",
    trustProxy: raw.TRUST_PROXY ?? false,
    publicUrl: raw.PUBLIC_URL ?? null,
    revision: raw.ROUTER_REVISION ?? UNKNOWN_REVISION,
    webRoot: raw.WEB_ROOT ?? null,
    claudeConfigRoot: raw.CLAUDE_CONFIG_ROOT ?? "/data/claude",
    claudeCliPath: raw.CLAUDE_CLI_PATH ?? null,
    claudeSdkMaxConcurrency: raw.CLAUDE_SDK_MAX_CONCURRENCY ?? 10,
    claudeSdkMaxConcurrencyPerAccount: raw.CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT ?? 4,
    metricsToken: raw.METRICS_TOKEN ?? null,
    sentryDsn: raw.SENTRY_DSN ?? null,
    sentryEnvironment: raw.SENTRY_ENVIRONMENT ?? "production",
    adminApiToken: raw.ADMIN_API_TOKEN ?? null,
    accountRecheckCooldownSeconds: raw.ACCOUNT_RECHECK_COOLDOWN_SECONDS ?? 60,
    // Longer than the re-check default on purpose: this one costs money (and, on the Agent-SDK
    // path, a subprocess), so the button that spends it should not be as cheap to lean on.
    accountTestNowCooldownSeconds: raw.ACCOUNT_TEST_NOW_COOLDOWN_SECONDS ?? 120,
    retention: {
      sessionsHours: raw.RETENTION_SESSIONS_HOURS ?? 24,
      usageDays,
      usageDailyDays,
      auditDays: raw.RETENTION_AUDIT_DAYS ?? 365,
      // A month of run rows: long enough to answer "has this task been failing all week", short
      // enough that six tasks ticking as often as every five minutes stay a table nobody notices.
      taskRunsDays: raw.RETENTION_TASK_RUNS_DAYS ?? 30,
      revokedKeysDays: raw.RETENTION_REVOKED_KEYS_DAYS ?? 30,
      oauthStateMinutes: raw.RETENTION_OAUTH_STATE_MINUTES ?? 10,
      // A day, because the failure it covers is a crash between provisioning a directory and
      // inserting the row that names it, and the operator who notices at all notices the next
      // morning. Shortening it buys a little disk and risks deleting a live login.
      orphanConfigDirHours: raw.RETENTION_ORPHAN_CONFIG_DIR_HOURS ?? 24,
    },
    janitorIntervalMinutes: raw.JANITOR_INTERVAL_MINUTES ?? 60,
    scheduler: {
      usageRollupIntervalMinutes: raw.USAGE_ROLLUP_INTERVAL_MINUTES ?? 60,
      oauthStatePurgeIntervalMinutes: raw.OAUTH_STATE_PURGE_INTERVAL_MINUTES ?? 5,
      quotaFloorIntervalMinutes: raw.QUOTA_FLOOR_INTERVAL_MINUTES ?? 30,
      // Hours, not minutes: an orphan is a crash artifact, so a router that never crashes sweeps
      // an empty root forever and one that did leaves a directory nobody is racing to reclaim.
      configDirReapIntervalMinutes: raw.CONFIG_DIR_REAP_INTERVAL_MINUTES ?? 360,
      // Minutes, not hours: an idle console session outlives its own expiry by up to one tick's
      // worth of memory, and a login-heavy operator day should not let that pile up for hours.
      adminSessionPurgeIntervalMinutes: raw.ADMIN_SESSION_PURGE_INTERVAL_MINUTES ?? 30,
      // Daily. Each account is still only touched once per idle window — see the field note.
      idleAccountProbeIntervalMinutes: raw.IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES ?? 1_440,
      idleAccountAfterDays: raw.IDLE_ACCOUNT_AFTER_DAYS ?? 7,
      idleAccountProbeBatchSize: raw.IDLE_ACCOUNT_PROBE_BATCH_SIZE ?? 5,
      // Hourly, and a batch that covers a normal fleet in one tick. Bigger than the keepalive's
      // five because these are plain GETs against a listing endpoint, not billed turns.
      modelCatalogRefreshIntervalMinutes: raw.MODEL_CATALOG_REFRESH_INTERVAL_MINUTES ?? 60,
      modelCatalogRefreshBatchSize: raw.MODEL_CATALOG_REFRESH_BATCH_SIZE ?? 25,
      sweepBatchSize: raw.SWEEP_BATCH_SIZE ?? 1_000,
      jitterFraction: raw.SCHEDULER_JITTER_FRACTION ?? 0.2,
    },
    oauthRefresh: {
      leadFraction: raw.OAUTH_REFRESH_LEAD_FRACTION ?? 0.75,
      minDelaySeconds: raw.OAUTH_REFRESH_MIN_DELAY_SECONDS ?? 30,
      maxAttempts: raw.OAUTH_REFRESH_MAX_ATTEMPTS ?? 5,
    },
    adminAuth: {
      sessionIdleMinutes: raw.ADMIN_SESSION_IDLE_MINUTES ?? 480,
      sessionAbsoluteHours: raw.ADMIN_SESSION_ABSOLUTE_HOURS ?? 24,
      loginMaxAttempts: raw.ADMIN_LOGIN_MAX_ATTEMPTS ?? 5,
      loginAttemptWindowMinutes: raw.ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES ?? 15,
      loginLockoutMinutes: raw.ADMIN_LOGIN_LOCKOUT_MINUTES ?? 15,
      sessionSlideFraction: raw.ADMIN_SESSION_SLIDE_FRACTION ?? 0.1,
      sessionCookieInsecure: raw.SESSION_COOKIE_INSECURE ?? false,
      localLoginAllowPublic: raw.ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC ?? false,
    },
    // Defaults mirror the layer constants they override, so an unset variable
    // and a variable set to the default behave identically.
    dataPlane: {
      catalogRefreshSeconds: raw.CATALOG_REFRESH_SECONDS ?? 30,
      keyCacheMax: raw.KEY_CACHE_MAX ?? 4_096,
      keyCacheTtlSeconds: raw.KEY_CACHE_TTL_SECONDS ?? 60,
      keyCacheNegativeTtlSeconds: raw.KEY_CACHE_NEGATIVE_TTL_SECONDS ?? 5,
      sessionCacheMax: raw.SESSION_CACHE_MAX ?? 4_096,
      sessionCacheTtlSeconds: raw.SESSION_CACHE_TTL_SECONDS ?? 300,
      sessionCacheNegativeTtlSeconds: raw.SESSION_CACHE_NEGATIVE_TTL_SECONDS ?? 30,
      usageQueueMax: raw.USAGE_QUEUE_MAX ?? 10_000,
      usageBatchSize: raw.USAGE_BATCH_SIZE ?? 200,
      usageFlushIntervalMs: raw.USAGE_FLUSH_INTERVAL_MS ?? 1_000,
      quotaWriteIntervalMs: raw.QUOTA_WRITE_INTERVAL_MS ?? 5_000,
      accountStatusWriteIntervalMs: raw.ACCOUNT_STATUS_WRITE_INTERVAL_MS ?? 1_000,
      maxRequestBodyBytes: raw.MAX_REQUEST_BODY_BYTES ?? 32 * 1024 * 1024,
    },
    failover: {
      maxAttempts: raw.ROUTING_MAX_ATTEMPTS ?? 3,
      failureThreshold: raw.ROUTING_FAILURE_THRESHOLD ?? 3,
      baseBackoffMs: raw.ROUTING_BASE_BACKOFF_MS ?? 1_000,
      maxBackoffMs: raw.ROUTING_MAX_BACKOFF_MS ?? 300_000,
      halfOpenHoldMs: raw.ROUTING_HALF_OPEN_HOLD_MS ?? 30_000,
      upstreamTimeoutMs: raw.UPSTREAM_TIMEOUT_MS ?? 600_000,
      boundAccountCoolingDown: raw.ROUTING_BOUND_ACCOUNT_COOLING_DOWN ?? "fail",
    },
    translation: {
      defaultMaxTokens: raw.TRANSLATE_DEFAULT_MAX_TOKENS ?? 4_096,
    },
  }
})

/**
 * Validates a raw environment map into `Env`.
 *
 * @throws EnvValidationError naming every offending variable.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(compact(raw))
  if (result.success) return result.data
  throw toEnvValidationError(result.error)
}

/** An unset variable and one set to the empty string mean the same thing to an operator. */
function compact(raw: Record<string, string | undefined>): Record<string, string> {
  const compacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length > 0) compacted[name] = trimmed
  }
  return compacted
}

function toEnvValidationError(error: z.ZodError): EnvValidationError {
  const variables: string[] = []
  const lines: string[] = []
  for (const issue of error.issues) {
    const name = issue.path.map(String).join(".") || "(environment)"
    if (!variables.includes(name)) variables.push(name)
    // Every raw value is a string, so the only `invalid_type` here is an absent variable.
    lines.push(`  ${name}: ${issue.code === "invalid_type" ? "is required" : issue.message}`)
  }
  const message = `Invalid environment configuration:\n${lines.join("\n")}`
  return new EnvValidationError(message, variables)
}
