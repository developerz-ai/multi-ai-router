import { disableThinkingForForcedTool } from "./body/forced-tool-thinking"
import { rewriteModel } from "./body/read"
import type { ChainContext } from "./chain"
import { sessionCacheKey } from "./egress/cache-key-header"
import { modelOutputCeiling } from "./model-output-ceiling"
import type { ServableCandidate } from "./plan"

/**
 * The body this account gets. Passthrough: identical bytes, unless routing renamed the model — the
 * account's alias map, or a stripped context tag (`routing/context-tag.ts`) — the one edit a
 * passthrough body ever receives, plus `thinking: disabled` beside a forced tool choice for a vendor
 * that thinks by default. Translate: rebuilt field by field,
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
      routerCacheKey(ctx, servable),
    )
  }
  if (ctx.bodyBytes.length === 0) return null
  const named =
    ctx.modelSpan === null || servable.upstreamModel === ctx.runtime.model
      ? ctx.bodyBytes
      : rewriteModel(ctx.bodyBytes, ctx.modelSpan, servable.upstreamModel)
  // The second passthrough edit: a vendor that thinks by default ignores a forced tool unless the
  // body states thinking off (`body/forced-tool-thinking.ts`). Real Anthropic is never asked.
  if (servable.kind === "http" && servable.driver.thinkingOnByDefault?.(servable.account.driver)) {
    return disableThinkingForForcedTool(named)
  }
  return named
}

/**
 * The session-derived `prompt_cache_key` for a surface that keys its prompt cache per conversation
 * (`ResponsesEgressRules.cacheKeyHeader`); undefined for every other upstream, whose body is
 * left as the translator wrote it.
 */
export function routerCacheKey(ctx: ChainContext, servable: ServableCandidate): string | undefined {
  if (servable.translation === null || servable.responsesEgress.cacheKeyHeader === undefined) {
    return undefined
  }
  const { apiKeyId, sessionKey, sessionKeySource } = ctx.runtime
  return sessionCacheKey(apiKeyId, sessionKey, sessionKeySource)
}
