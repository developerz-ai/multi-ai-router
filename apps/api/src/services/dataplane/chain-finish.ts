import { NoHealthyAccountError } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
import type { UsageRecord } from "../usage"
import type { ChainFailure } from "./chain-error"
import { relayUpstreamError } from "./relay-error"

/** An earlier actionable provider verdict outranks later preparation or admission failures. */
export function finishChain(
  held: ChainFailure | null,
  lastFailure: AttemptFailure | null,
  failIfRefused: () => void,
  selectTerminal?: (winner: UsageRecord | undefined) => void,
): Response {
  selectTerminal?.(held?.winner)
  if (held !== null) {
    if (held.kind === "router") throw held.error
    return relayUpstreamError(held.upstream, held.dialect)
  }
  if (lastFailure !== null)
    throw new NoHealthyAccountError(`every attempt failed: ${lastFailure.message}`)
  failIfRefused()
  throw new NoHealthyAccountError("no candidate account could be attempted")
}
