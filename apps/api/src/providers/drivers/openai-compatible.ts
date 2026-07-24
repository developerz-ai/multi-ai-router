import { createHttpDriver } from "../driver"
import { genericCreditsRule } from "./compatible-rules"

/**
 * `openai-compatible` — the escape hatch for any vLLM / Ollama / LiteLLM / vendor endpoint that
 * speaks OpenAI Chat Completions. No pinned endpoint: the Account's own base URL is the only
 * address it has, and an Account without one cannot be addressed at all.
 */
export const openAiCompatibleDriver = createHttpDriver({
  id: "openai-compatible",
  surfaces: [{ dialect: "openai-chat", baseUrl: null }],
  rules: [genericCreditsRule],
})
