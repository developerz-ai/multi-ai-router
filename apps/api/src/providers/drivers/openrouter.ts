import { createHttpDriver } from "../driver"
import { codeRule, messageRule, modelScoped, withResetEstimate } from "../failure/classify"
import type { ProviderDriver } from "../types"
import { openRouterKeyRead } from "./openrouter-key"

/**
 * `openrouter` — an aggregator, and a prepaid balance. Model ids are namespaced (`vendor/model`),
 * so an Account here almost always carries an alias map; the driver still never substitutes a
 * name on its own.
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `openrouter` request. */
const BASE_URL = "https://openrouter.ai/api/v1"

/**
 * Provenance: OpenRouter answers a spent balance with `402` and a message naming credits, and
 * echoes the numeric HTTP status back in `error.code` rather than a string identifier. Blast
 * radius: the wording rule is what catches a `402` proxied through as a `403`; it never reads a
 * `400`/`404`, where OpenRouter echoes the requested model id (sweep 101, 04.1).
 */
const INSUFFICIENT_CREDITS = /insufficient credits|requires more credits|add more using/i

/**
 * A per-key spend cap the operator set on the OpenRouter key, announced as
 * `403 "Key limit exceeded (total limit). Manage it using https://openrouter.ai/workspaces/…"`.
 *
 * Provenance: this router's production log, 2026-10-04 21:54Z — read as `http-status:403` → `auth`,
 * so a healthy key sat in "credential rejected" on the auth re-test cadence. It is not a credential
 * fault: the key is valid and its *spend* is capped. A `total` cap (or one naming no window) lifts
 * only when a human raises it, so it is `credits-exhausted` (402, never retried on a timer). A key
 * whose cap resets `daily` / `weekly` / `monthly` (OpenRouter's `limit_reset`, at 00:00 UTC) reopens
 * on a clock, so it is `rate-limited` with an estimated re-test — the reset instant is not in the
 * body, and the window wording is inferred from the `(total limit)` form, not yet observed.
 *
 * Blast radius: every OpenRouter 403 naming a key limit. Window first, so a resetting cap is never
 * parked as permanent.
 */
const KEY_LIMIT_WINDOW = /key limit exceeded\s*\((?:daily|weekly|monthly) limit\)/i
const KEY_LIMIT = /key limit exceeded/i

/**
 * Re-test cadence for a resetting key cap: the earliest a daily window can reopen is hours away,
 * and one probe an hour is all a still-capped key costs. Provenance: chosen 2026-10-04. Blast
 * radius: how soon a key whose daily cap reset is found serving again.
 */
const KEY_LIMIT_RETEST_SECONDS = 60 * 60

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
 * The refusal itself, for a namespaced id it does not carry — or no longer carries: a delisted model
 * answers `404 "<id> is no longer available on OpenRouter"` (prod 2026-11-09..10, `inception/mercury-2`,
 * 40 client-visible `404`s in 37.5 h; sweep 101, 10.16). About the name, so the next account gets its
 * turn and this one is not struck. Provenance: the two log lines. Blast radius: without it the chain
 * stops at this account.
 */
const MODEL_REFUSED = /is not a valid model id|is no longer available/i

/**
 * A `429` OpenRouter relays from the provider serving one model — `{"error":{"message":"Provider
 * returned error","code":429,"metadata":{"raw":"<model> is temporarily rate-limited upstream…",
 * "provider_name":…}}}` — is that model's endpoint throttling, not this key. Provenance:
 * openrouter.ai/docs/api-reference/errors (`metadata.provider_name` names the provider that raised
 * it), and this router's production log, 2026-11-14: one `google/gemma-4-31b-it:free` 429 cooled the
 * whole `openrouter-dz-coding-30d` account and its next, paid, model was refused. Blast radius: an
 * OpenRouter 429 with that wording holds only the model it was for.
 */
const UPSTREAM_THROTTLE = /provider returned error|rate-limited upstream/i

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
  rules: [
    modelScoped(
      messageRule("rate-limited", "openrouter:upstream-throttle", UPSTREAM_THROTTLE, {
        statuses: [429],
      }),
    ),
    withResetEstimate(
      messageRule("rate-limited", "openrouter:key-limit-window", KEY_LIMIT_WINDOW, {
        statuses: [403],
      }),
      KEY_LIMIT_RETEST_SECONDS,
    ),
    messageRule("credits-exhausted", "openrouter:key-limit", KEY_LIMIT, { statuses: [403] }),
    messageRule(
      "invalid-request",
      "openrouter:moderation",
      /moderation|flagged[^.]{0,80}content|content[^.]{0,80}flagged/i,
      { statuses: [403] },
    ),
    messageRule("model-unsupported", "openrouter:model-unsupported", MODEL_REFUSED, {
      statuses: [400, 404],
    }),
    messageRule("credits-exhausted", "openrouter:insufficient-credits", INSUFFICIENT_CREDITS, {
      statuses: [402, 403],
    }),
    codeRule("credits-exhausted", "openrouter:code-402", ["402"]),
    codeRule("rate-limited", "openrouter:code-429", ["429"]),
    codeRule("auth", "openrouter:code-401", ["401"]),
  ],
})

export const openRouterDriver: ProviderDriver = {
  ...driver,
  modelFamily: { patterns: [NAMESPACED_MODEL_ID] },
  routingVariants: ROUTING_VARIANTS,
  // An aggregator of several hundred models it does not itself serve: mirroring its catalog hourly
  // would make this router's listing mostly a stale copy of someone else's. The discover button
  // still asks it whenever an operator wants the answer.
  catalogSweep: "manual",
  // The key's own spend cap and its next reset (`openrouter-key.ts`).
  quotaRead: openRouterKeyRead,
}
