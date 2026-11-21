import type { TranslationContext } from "../translate/translation-pair"
import type { TranslationOptions } from "./dispatcher-config"

/**
 * The per-request half of `TranslationContext`, assembled from the injected clock and the
 * operator's translation options. The per-candidate members (`chatCeiling`, `responsesEgress`,
 * `cacheControl`, `reasoningSeal`) stay out: they vary per Account and are reapplied per attempt
 * (`translate-body.ts`), while these are fixed once the body and its routing fields are known.
 */
export function requestTranslation(
  startedAt: Date,
  model: string,
  requestId: string,
  options?: TranslationOptions,
): TranslationContext {
  return {
    // Injected clock: identical recorded bodies convert to identical bytes.
    created: Math.floor(startedAt.getTime() / 1000),
    model,
    fallbackId: requestId,
    defaultMaxTokens: options?.defaultMaxTokens,
    maximumPendingBytes: options?.maximumPendingBytes,
    thinkingDefaultModels: options?.thinkingDefaultModels,
  }
}
