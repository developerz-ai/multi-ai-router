import { createHttpDriver } from "../driver"
import { codeRule, typeRule } from "../failure/classify"

/**
 * `openai-api` — a standard platform key. Two surfaces share one base URL: Chat Completions is
 * what the installed base sends, Responses is where new clients are going, and an Account picks
 * which one it speaks (docs/idea/06-protocol-translation.md).
 */

/** Provenance: docs/idea/03-providers.md registry table. Blast radius: every `openai-api` request. */
const BASE_URL = "https://api.openai.com/v1"

/**
 * Provenance: OpenAI returns **429** with `code: "insufficient_quota"` when the billing balance
 * is spent — the same status it uses for real rate limiting. Blast radius: reading the status
 * alone marks a dead account `cooling_down` and retries it on a timer forever, which is exactly
 * the conflation CLAUDE.md forbids.
 */
const CREDIT_CODES = ["insufficient_quota", "billing_hard_limit_reached", "account_deactivated"]

/**
 * Provenance: OpenAI's published OpenAPI marks `max_tokens` `deprecated: true` — "This value is now
 * deprecated in favor of `max_completion_tokens`, and is not compatible with o-series models" — and
 * declares `max_completion_tokens` as an ungated property of the request, accepted by every chat
 * model on the platform. So it is stated once, per provider, and never sniffed per model name.
 *
 * Blast radius: every **translated** request toward an `openai-api` account — an Anthropic or
 * Responses client reaching one. Under the old name those were a `400 Unsupported parameter` on
 * `o1` / `o3` / `o4-mini` / `gpt-5`, which is to say on every reasoning model this platform sells. A
 * same-dialect request is opaque bytes and keeps whichever name the client wrote
 * (docs/idea/06-protocol-translation.md#known-lossy-edges).
 *
 * Deliberately **not** copied to the vendors that also accept the new name (Groq, xAI, Cerebras,
 * Kimi, MiniMax deprecate `max_tokens` in their own references but still honour it): they lose
 * nothing today, and five others — DeepSeek, Mistral, Together, Ollama, z.ai — state no
 * `max_completion_tokens` at all. Sent one, Ollama drops the field and generates unbounded, and
 * Mistral's schema forbids extras outright.
 */
const CHAT_CEILING = "max_completion_tokens" as const

export const openAiApiDriver = createHttpDriver({
  id: "openai-api",
  surfaces: [
    { dialect: "openai-chat", baseUrl: BASE_URL, chatCeiling: CHAT_CEILING },
    { dialect: "openai-responses", baseUrl: BASE_URL },
  ],
  rules: [
    codeRule("credits-exhausted", "openai:insufficient_quota", CREDIT_CODES),
    typeRule("credits-exhausted", "openai:insufficient_quota", CREDIT_CODES),
    codeRule("rate-limited", "openai:rate_limit_exceeded", ["rate_limit_exceeded"]),
    codeRule("auth", "openai:invalid_api_key", ["invalid_api_key", "invalid_organization"]),
  ],
})
