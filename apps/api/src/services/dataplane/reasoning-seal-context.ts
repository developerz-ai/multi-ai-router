import type { ReasoningSeal } from "../crypto/reasoning-seal"
import type { TranslationContext } from "../translate/registry"

/**
 * The selected account's reasoning seal, as the conversion and the response relay are handed it.
 * Per candidate, never per request: a seal opens only what its own account issued, so a failover
 * hop re-converts under the next account's seal (`translate-body.ts` keys the cache by it).
 */
export interface AccountReasoningSeal {
  readonly accountId: string
  readonly seal: ReasoningSeal
}

/**
 * `TranslationContext` plus the seal. Spelled here, as an intersection, so the dataplane hands the
 * seal over whether or not `TranslationContext` itself declares `reasoningSeal` yet; once it does,
 * this is the same type.
 */
export type SealedTranslationContext = TranslationContext & {
  readonly reasoningSeal?: ReasoningSeal | undefined
}

export function withReasoningSeal(
  context: TranslationContext,
  seal: AccountReasoningSeal | undefined,
): SealedTranslationContext {
  return seal === undefined ? context : { ...context, reasoningSeal: seal.seal }
}
