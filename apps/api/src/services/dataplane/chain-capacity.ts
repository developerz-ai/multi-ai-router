import { DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS } from "@multi-ai-router/core"
import type { FailureKind } from "../routing"
import type { HealthStore } from "./health"

/** Failures a wait on the same pool can clear: nothing about the request, nothing a human fixes. */
const CAPACITY_KINDS: ReadonlySet<FailureKind> = new Set<FailureKind>([
  "overloaded",
  "server-error",
  "connection",
  "timeout",
])

/**
 * The `Retry-After` a chain that failed only on capacity answers its `503` with (plan 101, 13.8):
 * the soonest breaker cooldown among the accounts it tried, else the configured unknown-reset wait.
 * `undefined` when any failure was not capacity — then a wait is not the remedy and none is named.
 */
export function capacityRetryAfterSeconds(input: {
  readonly kinds: readonly FailureKind[]
  readonly triedAccountIds: readonly string[]
  readonly health: Pick<HealthStore, "stateOf">
  readonly now: Date
  readonly unknownResetRetryAfterSeconds: number | undefined
}): number | undefined {
  if (input.kinds.length === 0 || !input.kinds.every((kind) => CAPACITY_KINDS.has(kind)))
    return undefined
  let soonest: number | undefined
  for (const id of input.triedAccountIds) {
    const until = input.health.stateOf(id).breaker.cooldownUntil
    if (until === undefined || until.getTime() <= input.now.getTime()) continue
    const seconds = Math.ceil((until.getTime() - input.now.getTime()) / 1_000)
    soonest = soonest === undefined ? seconds : Math.min(soonest, seconds)
  }
  return soonest ?? input.unknownResetRetryAfterSeconds ?? DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS
}
