import type { Dialect, ProviderId } from "@multi-ai-router/core"
import type { ProviderDescriptor } from "./api/types"

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
  "opencode-go": "OpenCode Go",
  "opencode-oauth": "OpenCode Console login",
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

const DIALECT_NAME: Readonly<Record<Dialect, string>> = {
  anthropic: "Anthropic Messages",
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
}

/** Beside the dialect control. Same-dialect traffic is a byte relay; any other is translated. */
export const DIALECT_HINT =
  "The wire protocol this account is addressed on. Pick the one its clients speak: a matching request is relayed untouched, any other is translated."

/**
 * The dialect control's options, default first. The default says what it resolves to, because
 * "Provider default" beside three real surfaces asks the operator to go and find out.
 */
export function dialectChoices(
  provider: Pick<ProviderDescriptor, "nativeDialect" | "supportedDialects"> | undefined,
): readonly { readonly value: string; readonly label: string }[] {
  const native = provider?.nativeDialect ?? null
  return [
    {
      value: "",
      label: native === null ? "Provider default" : `Provider default — ${DIALECT_NAME[native]}`,
    },
    ...(provider?.supportedDialects ?? []).map((value) => ({
      value,
      label: `${DIALECT_NAME[value]} (${value})`,
    })),
  ]
}

// What a provider's key has to be, where the wrong kind authenticates and is refused later. Keyed
// by id only because `GET /providers` has no field for it yet; that field is where this belongs.
const CREDENTIAL_NOTE: Readonly<Partial<Record<ProviderId, string>>> = {
  "opencode-go":
    "Use a team member's personal key, one per account. A service-account key of the same workspace authenticates and is then refused on every Go model.",
}

/** The warning for this provider's credential box, or null where it has none. */
export function providerCredentialNote(id: string): string | null {
  return Object.hasOwn(CREDENTIAL_NOTE, id) ? (CREDENTIAL_NOTE[id as ProviderId] ?? null) : null
}

/** Every id this build names, for the drift test against core's enum. */
export const NAMED_PROVIDER_IDS: readonly ProviderId[] = Object.keys(DISPLAY_NAME) as ProviderId[]
