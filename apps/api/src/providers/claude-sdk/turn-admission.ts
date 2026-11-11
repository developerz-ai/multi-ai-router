import type { SdkConcurrency, SdkSlot } from "./concurrency"
import type { CredentialFreshness } from "./credential-freshness"

/**
 * One turn's admission: its refresh-window claims and its concurrency slot, released together.
 *
 * Freshness is asked before the slot — waiting on another's refresh while holding a slot wastes it
 * — and re-asked once the slot is granted, because the queue wait is unbounded and a token warm at
 * admission can cross the CLI's refresh lead while queued. The re-ask carries the first claim
 * (`ensureFresh`'s `held`), so a caller that already owns the window is not made to wait on itself.
 *
 * `release` is built from this admission's own values, never from bindings a later attempt can
 * reassign: a busy-session retry takes a second admission, and the first attempt's late epilogue
 * must release only what the first attempt held (`invoker.ts`). Idempotent, like each part.
 */
export interface TurnAdmission {
  readonly slot: SdkSlot
  readonly release: () => void
}

export async function admitTurn(
  deps: { readonly freshness: CredentialFreshness; readonly concurrency: SdkConcurrency },
  accountId: string,
  signal: AbortSignal,
): Promise<TurnAdmission> {
  const claim = await deps.freshness.ensureFresh(accountId, signal)
  let slot: SdkSlot
  try {
    slot = await deps.concurrency.acquire(accountId, signal)
  } catch (error) {
    claim.release()
    throw error
  }
  try {
    const rechecked = await deps.freshness.ensureFresh(accountId, signal, claim)
    return {
      slot,
      release: () => {
        slot.release()
        rechecked.release()
        claim.release()
      },
    }
  } catch (error) {
    slot.release()
    claim.release()
    throw error
  }
}
