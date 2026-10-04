import { rewriteModel } from "./body/read"
import type { ChainContext } from "./chain"
import { modelOutputCeiling } from "./model-output-ceiling"
import type { ServableCandidate } from "./plan"

/**
 * The body this account gets. Passthrough: identical bytes, unless routing renamed the model — the
 * account's alias map, or a stripped context tag (`routing/context-tag.ts`) — the one edit a
 * passthrough body ever receives. Translate: rebuilt field by field,
 * which a Claude subscription also takes since the SDK's prompt is built from Anthropic-shaped
 * bytes either way.
 *
 * @throws TranslationError when a translated body has a field with no target representation.
 */
export function bodyFor(ctx: ChainContext, servable: ServableCandidate): Uint8Array | null {
  const pair = servable.translation
  if (pair !== null) {
    return ctx.translated.bodyFor(
      pair,
      servable.upstreamModel,
      servable.chatCeiling,
      pair.egress === "anthropic"
        ? modelOutputCeiling(
            ctx.modelMetadata,
            servable.candidate.account.id,
            servable.upstreamModel,
          )
        : undefined,
      servable.responsesEgress,
    )
  }
  if (ctx.bodyBytes.length === 0) return null
  if (ctx.modelSpan === null || servable.upstreamModel === ctx.runtime.model) return ctx.bodyBytes
  return rewriteModel(ctx.bodyBytes, ctx.modelSpan, servable.upstreamModel)
}
