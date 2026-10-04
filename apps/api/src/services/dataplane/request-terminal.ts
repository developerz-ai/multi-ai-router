import type { UsageRecord } from "../usage"
import type { DispatchInput } from "./dispatcher-config"
import type { RequestProgress } from "./observe"
import { sampleOf } from "./observe"
import type { DataPlaneClock, RequestObserver } from "./types"

/** Logical demand is reported once at terminal settlement, never from response headers. */
export function requestTerminalObserver(
  input: DispatchInput,
  progress: RequestProgress,
  clock: DataPlaneClock,
  observe: RequestObserver | undefined,
): ((event: UsageRecord) => void) | undefined {
  if (observe === undefined) return undefined
  const ingressDialect = input.ingress
  const keyId = input.key.id
  const requestedPoolIds =
    input.key.scope.kind === "pools" ? [...new Set(input.key.scope.poolIds)] : []
  return (event) => {
    observe({
      ...sampleOf({ ingressDialect, keyId }, progress, event.outcome, clock, event.streamed),
      requestedPoolIds,
      servedPoolId: event.poolId,
      bodyReadMs:
        progress.bodyReadMs +
        (progress.bodyReadWaitingSince === undefined
          ? 0
          : Math.max(0, clock.elapsed() - progress.bodyReadWaitingSince)),
    })
  }
}
