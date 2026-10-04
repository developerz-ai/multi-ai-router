/**
 * Scheduler task intervals and tuning.
 *
 * Every interval is config, never a constant in code (CLAUDE.md non-negotiable 11).
 * The actual interval is jittered around the configured value so sweeps never pile
 * onto request spikes or onto each other after a restart.
 */
export interface SchedulerConfig {
  readonly lockPoolMaxConnections: number
  readonly localCapacityRetryMs: number
  /** Usage record rollup interval, in minutes. */
  readonly usageRollupIntervalMinutes: number
  /** OAuth state (and PKCE verifier) purge interval, in minutes. */
  readonly oauthStatePurgeIntervalMinutes: number
  /** Account quota floor probe interval, in minutes. */
  readonly quotaFloorIntervalMinutes: number
  /** Orphaned `CLAUDE_CONFIG_DIR` reap interval, in minutes. The window itself is `retention`. */
  readonly configDirReapIntervalMinutes: number
  /** Agent-SDK transcript sweep interval, in minutes. The window itself is `retention`. */
  readonly sdkTranscriptSweepIntervalMinutes: number
  /**
   * Admin console session purge interval, in minutes. Sweeps the in-memory `SessionStore`, not a
   * table, so every replica runs it against its own heap — see `scheduler/tasks/admin-session-purge.ts`.
   */
  readonly adminSessionPurgeIntervalMinutes: number
  /**
   * How often the credential sweep runs: the free `claude auth status` check over every
   * CLI-managed account, then the billed keepalive over the idle ones. Daily by default — the
   * *billed cadence per account* is set by `idleAccountAfterDays`, not by this, because a probed
   * account stops being idle until that threshold passes again.
   */
  readonly idleAccountProbeIntervalMinutes: number
  /**
   * How long an account must have gone unused before one real, billed request is spent on it.
   * What that buys: the SDK refreshes a Claude subscription's *access* token only when it runs,
   * so an account nobody routes to fails its first request after a long silence with a stale one
   * (`scheduler/tasks/idle-account-probe.ts`).
   *
   * What it does **not** buy, and the reason the old "keep it inside the refresh-token life"
   * advice is gone: a subscription's refresh token hard-expires ~30 days after login however
   * much it is used (verified in production, 2026-09-05). No request moves that date — only a
   * re-login does. The free check on the same tick is what finds an expired one within a day.
   */
  readonly idleAccountAfterDays: number
  /**
   * Accounts probed per keepalive tick. Small on purpose and separate from `sweepBatchSize`: each
   * item may spawn a ~245 MB `claude` subprocess and bill a turn, which is nothing like deleting a
   * row. The sweep is resumable, so a backlog drains over consecutive ticks.
   */
  readonly idleAccountProbeBatchSize: number
  /**
   * Whether the keepalive spends a real, billed turn on each idle account. **Off by default**: a
   * turn refreshes only a Claude subscription's *access* token — the 30-day refresh-token cliff is
   * unaffected — so the operator was paying usage for a check that could not achieve its aim.
   * The free `claude auth status` check still runs daily over every subscription; this flag is
   * the only thing that lets the sweep bill anything (`scheduler/tasks/idle-account-probe.ts`).
   */
  readonly idleAccountProbePaidTurn: boolean
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
  readonly lockPoolMaxConnections: number
  /** Share of a token's remaining lifetime allowed to elapse first. `0.75` leaves a quarter. */
  readonly leadFraction: number
  /** Floor on any refresh delay, and the first step of the retry backoff. Never zero. */
  readonly minDelaySeconds: number
  /** Unreachable-issuer attempts before the account is parked. A refusal is never retried. */
  readonly maxAttempts: number
}
