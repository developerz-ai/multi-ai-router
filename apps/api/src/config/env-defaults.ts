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
 * Sixty seconds: four client heartbeats (`DEFAULT_STREAM_PACING.heartbeatMs`, 15 s) fit inside it
 * with room for the 4 s granularity Bun's sweep runs at. `test/unit/listen.test.ts` holds the
 * pairing, so retuning either number alone fails a test rather than a fleet.
 */
export const DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS = 60

/**
 * The two probes the image's healthcheck and an orchestrator poll. `/` is deliberately not here:
 * it is the console's entry point, and whether a hit on it is a load balancer or an operator is
 * something only the deployment knows — an operator whose balancer probes `/` adds it.
 */
export const DEFAULT_LOG_QUIET_PATHS: readonly string[] = ["/healthz", "/readyz"]
