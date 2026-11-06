import { NoHealthyAccountError } from "@multi-ai-router/core"
import type { AttemptFailure } from "../routing"
import type { UsageRecord } from "../usage"
import type { ChainFailure } from "./chain-error"
import { relayUpstreamError } from "./relay-error"
import { servedByHeaders, withHeaders } from "./router-headers"

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
    const relayed = relayUpstreamError(held.upstream, held.dialect)
    const { winner } = held
    // The account whose own words these are is named, as on a success (`router-headers.ts`).
    return winner === undefined ||
      winner.accountId === null ||
      winner.provider === null ||
      winner.upstreamModel === null
      ? relayed
      : withHeaders(
          relayed,
          servedByHeaders({
            accountId: winner.accountId,
            provider: winner.provider,
            upstreamModel: winner.upstreamModel,
          }),
        )
  }
  if (lastFailure !== null)
    throw new NoHealthyAccountError(`every attempt failed: ${lastFailure.message}`)
  throw new NoHealthyAccountError("no candidate account could be attempted")
}
