import { disableThinkingForForcedTool } from "./body/forced-tool-thinking"
import { rewriteModel } from "./body/read"
import type { ChainContext } from "./chain"
import { sessionCacheKey } from "./egress/cache-key-header"
import { modelOutputCeiling } from "./model-output-ceiling"
import type { ServableCandidate } from "./plan"
import type { AccountReasoningSeal } from "./reasoning-seal-context"

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
      keysPromptCache(servable) ? { fallback: routerCacheKey(ctx, servable) } : undefined,
      reasoningSealFor(ctx, servable),
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
 * The session-derived `prompt_cache_key` for a surface that keys its prompt cache per conversation —
 * by a header (`ResponsesEgressRules.cacheKeyHeader`, Codex) or by the body alone
 * (`ProviderSurface.bodyCacheKey`, OpenAI's platform, OpenRouter); undefined for every other
 * upstream, whose body is left as the translator wrote it. Translated bodies only: a same-dialect
 * body is the client's bytes and keeps whatever key the client wrote (non-negotiable 10).
 */
export function routerCacheKey(ctx: ChainContext, servable: ServableCandidate): string | undefined {
  if (servable.translation === null || !keysPromptCache(servable)) return undefined
  const { apiKeyId, sessionKey, sessionKeySource } = ctx.runtime
  return sessionCacheKey(apiKeyId, sessionKey, sessionKeySource)
}

function keysPromptCache(servable: ServableCandidate): boolean {
  if (servable.responsesEgress.cacheKeyHeader !== undefined) return true
  return (
    servable.kind === "http" &&
    servable.driver.keysPromptCacheByBody?.(servable.account.driver) === true
  )
}

/** The selected account's reasoning seal, for a translated attempt; undefined without a sealer. */
export function reasoningSealFor(
  ctx: Pick<ChainContext, "runtime">,
  servable: ServableCandidate,
): AccountReasoningSeal | undefined {
  const sealer = ctx.runtime.reasoningSealer
  if (sealer === undefined || servable.translation === null) return undefined
  const accountId = servable.account.id
  return { accountId, seal: sealer.forAccount(accountId) }
}
