import type { Env } from "../config/env"
import type { DispatchOptions } from "../services/dataplane"

/**
 * The one place parsed env becomes dispatcher behavior.
 *
 * Extracted from `createRuntime` so the mapping is unit-testable without a database or a booted
 * server: `ROUTING_BOUND_ACCOUNT_COOLING_DOWN` and its siblings were parsed at boot and consumed
 * only inside the full production wiring, which no test exercised — the exact shape of the
 * `ROUTING_FAILURE_THRESHOLD` bug (`services/dataplane/health.ts`, `HealthStoreOptions`).
 */

/**
 * `FailoverConfig` fields this file reads ahead of the env schema shipping them. Optional and
 * absent-tolerant on purpose: the routing layer holds the default, so the mapping compiles and
 * behaves correctly before the key lands, and starts honoring it the moment it does — with no
 * second edit here to forget.
 */
type PendingFailoverEnv = Env["failover"] & {
  /** `ROUTING_UNKNOWN_RESET_RETRY_AFTER_SECONDS` — see `routing/no-candidates.ts`. */
  readonly unknownResetRetryAfterSeconds?: number
}

export function dispatchOptionsFromEnv(env: Env): DispatchOptions {
  const failover: PendingFailoverEnv = env.failover
  return {
    failover: { maxAttempts: failover.maxAttempts },
    selection: {
      boundAccountCoolingDown: failover.boundAccountCoolingDown,
      ...(failover.unknownResetRetryAfterSeconds === undefined
        ? {}
        : { unknownResetRetryAfterSeconds: failover.unknownResetRetryAfterSeconds }),
    },
    upstreamTimeoutMs: failover.upstreamTimeoutMs,
    translation: { defaultMaxTokens: env.translation.defaultMaxTokens },
    // The one limit an unauthenticated-shaped mistake can spend memory on before anything else
    // runs, so it is the operator's to set rather than the reader's to assume.
    body: { maxBytes: env.dataPlane.maxRequestBodyBytes },
    // The same ceiling every other quoted `reason` in the process obeys, so the failed-attempt log
    // line cannot become the one line an operator cannot read.
    log: { reasonMaxChars: env.logReasonMaxChars },
  }
}
