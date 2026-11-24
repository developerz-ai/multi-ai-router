import type { FailureClassification, RateLimitSignal, UpstreamFailureKind } from "../failure-types"
import type { ProviderDriver } from "../types"

/**
 * Which model a reading came from, and what the classification said about its scope when the reply
 * was a refusal.
 */
export interface ReadingSource {
  readonly driver: Pick<ProviderDriver, "rateLimitsPerModel">
  readonly upstreamModel: string
  readonly classification?: Partial<
    Pick<FailureClassification, "kind" | "modelScoped" | "requestAttributable">
  > | null
}

/**
 * Verdicts the breaker never holds against an account: the shared backend, the model, the request or
 * the conversation. The limiter parser reads only the status, so a `429` that a body reclassified as
 * one of these (z.ai `1305`, `1311`, `1211`) is still `limited` to it.
 */
const NOT_THE_ACCOUNTS: ReadonlySet<UpstreamFailureKind> = new Set([
  "overloaded",
  "model-unsupported",
  "invalid-request",
  "stale-session",
  "busy-session",
])

/** Whether a limit read off this reply is the model's own, so it says nothing about the account. */
export function isModelLevelReading(source: ReadingSource): boolean {
  return (
    source.classification?.modelScoped === true ||
    source.driver.rateLimitsPerModel?.(source.upstreamModel) === true
  )
}

function isNotTheAccounts(classification: ReadingSource["classification"]): boolean {
  if (classification === undefined || classification === null) return false
  return (
    classification.requestAttributable === true ||
    (classification.kind !== undefined && NOT_THE_ACCOUNTS.has(classification.kind))
  )
}

/**
 * A reading as the **account** may hold it. A model-level limit is kept as a reading (its windows
 * still show, named quota windows still fold) but not as `limited`, which is what cools an account:
 * one spent free model on an NVIDIA, Gemini or OpenRouter key must leave the others serving. Every
 * path that folds a reply's reading into `HealthStore.applyRateLimit` — a served request, Test now,
 * a recovery probe, the cooldown recheck — asks this first. A refusal that was never about the account
 * is held the same way: the chain returns before folding one, and the probes fold every reply.
 */
export function accountLevelReading(
  signal: RateLimitSignal | null,
  source: ReadingSource,
): RateLimitSignal | null {
  if (signal === null || !signal.limited) return signal
  if (!isModelLevelReading(source) && !isNotTheAccounts(source.classification)) return signal
  return { ...signal, limited: false }
}
