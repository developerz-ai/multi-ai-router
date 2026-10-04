import type { ModelCatalogStore } from "../models/store"

/** Only the selected account's exact upstream-side model metadata may replace the missing-limit fallback. */
export function modelOutputCeiling(
  metadata: Pick<ModelCatalogStore, "describe"> | undefined,
  accountId: string,
  upstreamModel: string,
): number | undefined {
  const descriptor = metadata?.describe(accountId, upstreamModel)
  if (!descriptor || descriptor.id.trim().toLowerCase() !== upstreamModel.trim().toLowerCase())
    return undefined
  if (descriptor.contextSource !== "upstream" && descriptor.contextSource !== "shipped")
    return undefined
  const ceiling = descriptor.maxOutputTokens
  return ceiling !== null && Number.isSafeInteger(ceiling) && ceiling > 0 ? ceiling : undefined
}
