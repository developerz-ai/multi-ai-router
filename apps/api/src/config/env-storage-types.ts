export interface RetentionConfig {
  readonly sessionsHours: number
  readonly usageDays: number
  /**
   * History must outlive raw detail. Advancing the durable history horizon permits raw
   * retention to delete unregistered older rows, so a shorter window would discard history
   * while raw detail should still be retained. Boot refuses that ordering.
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
  /**
   * How long an Agent-SDK session transcript — the `<session>.jsonl` the `claude` CLI writes under
   * an Account's `CLAUDE_CONFIG_DIR` for `--resume` — is kept after its last turn. Paired with
   * {@link RetentionConfig.sessionsHours} by default: the row that could resume it and the file it
   * would resume expire together. A transcript removed under a still-live row costs one replay
   * from the client's own history, never a failed request (`scheduler/tasks/sdk-transcript-sweep.ts`).
   */
  readonly sdkTranscriptHours: number
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
