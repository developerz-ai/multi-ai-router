import { NoHealthyAccountError } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
import type { UsageRecord } from "../usage"
import type { ChainFailure } from "./chain-error"
import { relayUpstreamError } from "./relay-error"

/**
 * An earlier actionable provider verdict outranks later preparation failures. A recovery refusal
 * outranks nothing held and a held `429` — it is the one answer a short wait can turn into a
 * served request (`chain-refusals.ts`) — and is asked first for that reason.
 */
export function finishChain(
  held: ChainFailure | null,
  lastFailure: AttemptFailure | null,
  failIfRefused: (held: ChainFailure | null, lastFailure: AttemptFailure | null) => void,
  selectTerminal?: (winner: UsageRecord | undefined) => void,
): Response {
  selectTerminal?.(held?.winner)
  failIfRefused(held, lastFailure)
  if (held !== null) {
    if (held.kind === "router") throw held.error
    return relayUpstreamError(held.upstream, held.dialect)
  }
  if (lastFailure !== null)
    throw new NoHealthyAccountError(`every attempt failed: ${lastFailure.message}`)
  throw new NoHealthyAccountError("no candidate account could be attempted")
}
