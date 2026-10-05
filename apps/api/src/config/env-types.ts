import type { readAdminBodiesEnv } from "./admin-bodies"
import type { readBackgroundEnv } from "./background"
import type { ClaudeLoginConfig } from "./claude-login"
import type { readCliOwnershipEnv } from "./cli-ownership"
import type { AdminAuthConfig, AdminOidcConfig } from "./env-admin-types"
import type { LogLevel } from "./env-defaults"
import type { DataPlaneConfig, FailoverConfig, TranslationConfig } from "./env-routing-types"
import type { OAuthRefreshConfig, SchedulerConfig } from "./env-scheduler-types"
import type { DatabasePoolConfig, RetentionConfig } from "./env-storage-types"
import type { readMetricInventoryEnv } from "./metric-inventory"
import type { readRecoveryEnv } from "./recovery"
import type { readRelayLifetimesEnv } from "./relay-lifetimes"
import type { readUsageReadEnv } from "./usage-read"

export interface Env {
  readonly recovery: ReturnType<typeof readRecoveryEnv>["recovery"]
  readonly cliOwnership: ReturnType<typeof readCliOwnershipEnv>["cliOwnership"]
  readonly port: number
  /**
   * How long a connection may carry no bytes in either direction before the *server* closes it —
   * `Bun.serve`'s `idleTimeout`, in whole seconds.
   *
   * Unset, Bun applies its own default of 10 s and reaps on a 4 s sweep, and that default was
   * shorter than the 15 s heartbeat every SDK stream relies on to stay open. So a stream that went
   * quiet for 10–14 s died before its own keep-alive could fire: measured on the fleet on
   * 2026-09-07, every `Failed to read … stream` on the boxes sat on that 4 s grid, and a tool call
   * whose arguments took 11.8 s to generate — held whole by the rewriter, so the client saw nothing
   * until the block closed — reproduced it on demand. The heartbeat has to be comfortably *inside*
   * this; `0` disables the server's clock entirely and `255` is the ceiling (Bun keeps it in a byte).
   */
  readonly serverIdleTimeoutSeconds: number
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
  /**
   * Ceiling on how much of a described error — the full cause chain, innermost first — one log
   * line quotes as its `reason`. A driver names the statement it refused, and a batched statement
   * is thousands of bind parameters long; unbounded, the one line an operator needs becomes the
   * reason they cannot read any of them.
   */
  readonly logReasonMaxChars: number
  /**
   * `LOG_QUIET_PATHS`. Exact paths whose successful `request completed` lines log at `debug`
   * instead of `info` — the probes an orchestrator polls. Failures on them log as always.
   */
  readonly logQuietPaths: readonly string[]
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
   * The refresh-window guard (`providers/claude-sdk/credential-freshness.ts`). Inside `skew` of an
   * access token's expiry only one subprocess may cross; the rest wait up to `WaitMs`, re-reading
   * the credential file every `PollMs`, then proceed regardless.
   */
  /**
   * Whether a logged-in subscription account whose **access** token is cold is given one small real
   * turn before anything turn-free touches its directory. A real turn runs to completion and so
   * persists the rotated refresh token; a turn-free probe is ended before that write and spends the
   * token for nothing (`scheduler/tasks/idle-account-probe.ts`).
   */
  readonly claudeSdkCredentialKeepalive: boolean
  /**
   * How close to its access-token expiry a credential counts as **cold**: a turn-free `claude`
   * spawn is refused against it and the sweep's keepalive spends a real turn on it instead. Floored
   * at the CLI's own five-minute refresh lead (`CLI_REFRESH_LEAD_MS`), because a margin narrower
   * than that lets an idle query start exactly the refresh it cannot finish.
   */
  readonly claudeSdkCredentialColdMarginSeconds: number
  readonly claudeSdkCredentialRefreshSkewSeconds: number
  readonly claudeSdkCredentialRefreshWaitMs: number
  readonly claudeSdkCredentialRefreshPollMs: number
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
  /**
   * How long the admin accounts read trusts one reading of a Claude subscription's credential
   * *metadata* (login expiry, plan, tier — never the token; `providers/claude-sdk/credential-
   * metadata.ts`) before re-reading the file. A console poll must not stat six files a second.
   */
  readonly adminCredentialMetadataTtlSeconds: number
  /**
   * The Agent-SDK usage gauge: the plan's per-window percentages, asked of the SDK's own query
   * object once a turn has started answering (`providers/claude-sdk/usage-gauge.ts`). Never on
   * the response path, never a turn of its own.
   */
  readonly claudeSdkUsageGauge: {
    /** `CLAUDE_SDK_USAGE_GAUGE`. Off leaves the console showing alarms only. */
    readonly enabled: boolean
    /** `CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS`. A reading slower than this is dropped. */
    readonly timeoutMs: number
    /** `CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS`. At most one reading per account per interval. */
    readonly minIntervalSeconds: number
  }
  readonly retention: RetentionConfig
  readonly janitorIntervalMinutes: number
  readonly adminAuth: AdminAuthConfig
  readonly adminBodies: ReturnType<typeof readAdminBodiesEnv>["adminBodies"]
  readonly dataPlane: DataPlaneConfig
  readonly failover: FailoverConfig
  readonly metricInventory: ReturnType<typeof readMetricInventoryEnv>["metricInventory"]
  readonly relayLifetimes: ReturnType<typeof readRelayLifetimesEnv>["relayLifetimes"]
  readonly usageRead: ReturnType<typeof readUsageReadEnv>["usageRead"]
  readonly background: ReturnType<typeof readBackgroundEnv>["background"]
  readonly scheduler: SchedulerConfig
  /**
   * A Claude subscription's login lifetime (warn window, assumed lifetime, daily watch) and the
   * access-token keepalive cadence — `config/claude-login.ts`.
   */
  readonly claudeLogin: ClaudeLoginConfig
  readonly oauthRefresh: OAuthRefreshConfig
  readonly translation: TranslationConfig
}
