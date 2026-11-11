import type { Env } from "./env-types"

/**
 * The statement timeout a usage-read snapshot runs under: inside the listener's idle clock, so a
 * summary whose client was already cut cannot keep its repeatable-read transaction (and a pooled
 * connection) running after the socket is gone (08.1). Derived rather than its own setting — the
 * bound only means something relative to `SERVER_IDLE_TIMEOUT_SECONDS`. `undefined` when the
 * listener has no idle clock: the pool's `DB_STATEMENT_TIMEOUT_MS` is then the only bound.
 */
export function usageSnapshotStatementTimeoutMs(
  env: Pick<Env, "serverIdleTimeoutSeconds">,
): number | undefined {
  if (env.serverIdleTimeoutSeconds === 0) return undefined
  return Math.max(1, env.serverIdleTimeoutSeconds - SNAPSHOT_HEADROOM_SECONDS) * 1_000
}

/** Room for the response to be rendered and written once the last statement returns. */
const SNAPSHOT_HEADROOM_SECONDS = 5
