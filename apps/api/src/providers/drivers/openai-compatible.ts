import { createHttpDriver } from "../driver"
import { FREE_PRESETS } from "../free-presets"
import { parseCompatibleRateLimit } from "../rate-limit/compatible-body"
import type { ProviderDriver } from "../types"
import { genericCreditsRule, modelStudioRules, reportedQuotaResetRule } from "./compatible-rules"

/**
 * `openai-compatible` — the escape hatch for any vLLM / Ollama / LiteLLM / vendor endpoint that
 * speaks OpenAI Chat Completions. No pinned endpoint: the Account's own base URL is the only
 * address it has, and an Account without one cannot be addressed at all.
 */
const driver = createHttpDriver({
  id: "openai-compatible",
  surfaces: [{ dialect: "openai-chat", baseUrl: null }],
  parseRateLimit: parseCompatibleRateLimit,
  rules: [...modelStudioRules, reportedQuotaResetRule, genericCreditsRule],
})

export const openAiCompatibleDriver: ProviderDriver = { ...driver, freePresets: FREE_PRESETS }
