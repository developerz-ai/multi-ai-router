import { createHttpDriver } from "../driver"
import type { ProviderDriver } from "../types"
import { readOpenRouterCost } from "./openrouter-cost"
import { openRouterKeyRead } from "./openrouter-key"
import { OPENROUTER_RULES, parseOpenRouterRateLimit, readOpenRouterFacts } from "./openrouter-rules"

/**
 * `openrouter` — an aggregator, and a prepaid balance. Model ids are namespaced (`vendor/model`),
 * so an Account here almost always carries an alias map; the driver still never substitutes a
 * name on its own.
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `openrouter` request. */
const BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Provenance: openrouter.ai/docs/features/prompt-caching (read 2026-10-30) — "If neither is set,
 * OpenRouter falls back to the OpenAI-style `prompt_cache_key` request field as the sticky routing
 * key"; "Clients that already send `prompt_cache_key` get session-pinned routing without any
 * changes", and its OpenAI caching examples send the field. So it pins a conversation to one
 * provider endpoint (whose cache is warm) as well as reaching OpenAI's own cache routing. Blast
 * radius: every **translated** request to an `openrouter` account (an Anthropic-wire client)
 * carries a session-derived key; a same-dialect body is relayed untouched. If OpenRouter drops the
 * field, cache reads fall; nothing fails.
 */
const BODY_CACHE_KEY = true

/**
 * Provenance: openrouter.ai/docs/features/prompt-caching (read 2026-11-03) — `cache_control` on
 * content blocks is OpenRouter's own request field: honoured as explicit breakpoints for Anthropic
 * (every Anthropic-compatible provider, Bedrock and Vertex included), Gemini (last breakpoint used)
 * and Alibaba Qwen, translated to `prompt_cache_breakpoint` for OpenAI models that take one, and a
 * top-level marker is Anthropic's automatic caching. Surface-wide rather than per model: OpenRouter
 * maps the marker per provider, so a model-name allowlist here would only go stale. Blast radius:
 * every Anthropic-wire request translated to an `openrouter` account; without it Claude through
 * OpenRouter caches nothing and re-bills its whole prefix every turn.
 */
const CACHE_CONTROL = true

/**
 * Provenance: openrouter.ai/docs/features/prompt-caching (read 2026-11-03) — a body `session_id`
 * (up to 256 characters) is the sticky-routing key, and "when `session_id` is set, sticky routing
 * starts before any cache hit is observed"; without it `prompt_cache_key` is the fallback key. Blast
 * radius: every translated request to an `openrouter` account carries its cache key here too; if
 * OpenRouter drops the field, stickiness starts at the first cache hit as before.
 */
const BODY_SESSION_ID = true

/**
 * Provenance: openrouter.ai/docs/features/provider-routing (read 2026-11-14) — the request
 * `provider` object (`sort`, `quantizations`, `allow_fallbacks`, `order`, `only`, `ignore`,
 * `require_parameters`, …) picks which endpoint serves the model. The only way to ask for fp8 /
 * bf16: a slug suffix (`:floor`, `:nitro`) states a sort and nothing else. Blast radius: every
 * request to an `openrouter` account that carries preferences; one with none is sent as before.
 */
const PROVIDER_PREFERENCES = true

/**
 * Every OpenRouter id is `vendor/model` (`openrouter/auto` included), so a bare name is one it cannot
 * serve: it answers `400`, and that `400` used to reach the client in place of the quota error of the
 * account that does carry the name. Unknown still passes through on the namespaced side, because an
 * aggregator's catalog moves daily. Provenance: docs/idea/03-providers.md registry table, and this
 * router's production log, 2026-11-02 (`k3`). Blast radius: a bare name on an undeclared `openrouter`
 * account, which an alias or an explicit `supportedModels` still admits.
 */
const NAMESPACED_MODEL_ID = /^[^/\s]+\/[^/\s]\S*$/

/**
 * Free variants (`…:free`) carry OpenRouter's own free-model limits (`free-models-per-min`,
 * `free-models-per-day`), separate from a key's paid traffic: a free model's `429`, whatever its
 * wording, says nothing about the paid models on the same key. Provenance:
 * openrouter.ai/docs/api-reference/limits ("Free usage limits"). Blast radius: a `:free` model's 429
 * holds that model only; every other model on the account keeps serving.
 */
const FREE_VARIANT = /:free$/

/**
 * Routing variants: suffixes OpenRouter "accepted on every model ID and [are] never an entry in the
 * models API" — `:nitro` (sort by throughput), `:floor` (sort by price), `:exacto` (tool-calling
 * quality), `:online` (web search; deprecated, still accepted). Catalog variants — `:free`, `:batch`,
 * `:thinking`, `:extended` — are their own listed ids and are deliberately absent: stripping one
 * would admit a model the listing never named. Provenance:
 * openrouter.ai/docs/guides/routing/model-variants (read 2026-11-15; "Only the suffixes listed on
 * this page are variants"). Blast radius: prod 2026-11-15, `deepseek/deepseek-v4.1-flash:floor` was
 * refused `model-unsupported` ~2,000 times in 19 h once `supportedModels` was re-listed from
 * `/models`, which never carries a routing variant.
 */
const ROUTING_VARIANTS = [":floor", ":nitro", ":exacto", ":online"] as const

const driver = createHttpDriver({
  id: "openrouter",
  surfaces: [
    {
      dialect: "openai-chat",
      baseUrl: BASE_URL,
      bodyCacheKey: BODY_CACHE_KEY,
      cacheControl: CACHE_CONTROL,
      bodySessionId: BODY_SESSION_ID,
      providerPreferences: PROVIDER_PREFERENCES,
    },
  ],
  modelScopedRateLimits: FREE_VARIANT,
  // The per-route price no table can hold: OpenRouter states what it billed (`openrouter-cost.ts`).
  responseObservation: { terminalPolicy: "evidence-only", reportedCost: readOpenRouterCost },
  readFacts: readOpenRouterFacts,
  parseRateLimit: parseOpenRouterRateLimit,
  rules: OPENROUTER_RULES,
})

export const openRouterDriver: ProviderDriver = {
  ...driver,
  modelFamily: { patterns: [NAMESPACED_MODEL_ID] },
  routingVariants: ROUTING_VARIANTS,
  // An aggregator of several hundred models it does not itself serve: mirroring its catalog hourly
  // would make this router's listing mostly a stale copy of someone else's. The discover button
  // still asks it whenever an operator wants the answer.
  catalogSweep: "manual",
  freeTier: {
    access: "free-key",
    url: "https://openrouter.ai/workspaces/default/keys",
    note: "Models ending in :free cost nothing: 20 requests a minute; 50 a day; or 1,000 a day once the account has spent $10 (OpenRouter's published tier table, openrouter.ai). The daily quota belongs to the vendor account, not a workspace — a second key adds nothing. OpenRouter's own page documents fees and any one-credit rounding tolerance separately; neither changes these caps. A negative balance can refuse free ids too.",
    verifiedAt: "2026-11-23",
  },
  // The key's own spend cap and its next reset (`openrouter-key.ts`).
  quotaRead: openRouterKeyRead,
}
