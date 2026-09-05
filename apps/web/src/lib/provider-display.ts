import type { ProviderId } from "@multi-ai-router/core"

// Provider id → the name an operator reads. Presentation only: the registry in
// `apps/api/src/providers/` stays the single definition of what exists, and this
// map is keyed by core's union so a provider added there fails this build until
// it has a name here — the same drift gate `account-status.ts` uses.

const DISPLAY_NAME: Readonly<Record<ProviderId, string>> = {
  "anthropic-oauth": "Claude subscriptions",
  "anthropic-api": "Anthropic API",
  "openai-oauth": "ChatGPT / Codex subscriptions",
  "openai-api": "OpenAI API",
  openrouter: "OpenRouter",
  zai: "Z.ai",
  kimi: "Kimi (Moonshot)",
  minimax: "MiniMax",
  gemini: "Google Gemini",
  groq: "Groq",
  deepseek: "DeepSeek",
  xai: "xAI",
  mistral: "Mistral",
  together: "Together",
  cerebras: "Cerebras",
  ollama: "Ollama",
  "openai-compatible": "OpenAI-compatible endpoints",
  "anthropic-compatible": "Anthropic-compatible endpoints",
}

/**
 * The display name, or the id itself for a value this build does not know — an older console
 * against a newer router must still render the group rather than an empty heading.
 */
export function providerDisplayName(id: string): string {
  // `hasOwn`, not a bare index: a plain object lookup would answer `toString` for a provider
  // named after an `Object.prototype` member. Types only from core — a runtime import would
  // compile zod into the browser bundle for one lookup.
  return Object.hasOwn(DISPLAY_NAME, id) ? DISPLAY_NAME[id as ProviderId] : id
}

/** Every id this build names, for the drift test against core's enum. */
export const NAMED_PROVIDER_IDS: readonly ProviderId[] = Object.keys(DISPLAY_NAME) as ProviderId[]
