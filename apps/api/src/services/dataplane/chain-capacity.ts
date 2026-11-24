import { DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS } from "@multi-ai-router/core"
import type { FailureKind } from "../routing"
import type { DispatchRuntime } from "./runtime"

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
export function capacityRetryAfterSeconds(
  runtime: Pick<DispatchRuntime, "health" | "clock" | "unknownResetRetryAfterSeconds">,
  kinds: readonly FailureKind[],
  triedAccountIds: readonly string[],
): number | undefined {
  if (kinds.length === 0 || !kinds.every((kind) => CAPACITY_KINDS.has(kind))) return undefined
  const now = runtime.clock.now().getTime()
  let soonest: number | undefined
  for (const id of triedAccountIds) {
    const until = runtime.health.stateOf(id).breaker.cooldownUntil
    if (until === undefined || until.getTime() <= now) continue
    const seconds = Math.ceil((until.getTime() - now) / 1_000)
    soonest = soonest === undefined ? seconds : Math.min(soonest, seconds)
  }
  return (
    soonest ?? runtime.unknownResetRetryAfterSeconds ?? DEFAULT_UNKNOWN_RESET_RETRY_AFTER_SECONDS
  )
}
