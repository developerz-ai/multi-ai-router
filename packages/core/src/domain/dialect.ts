import { z } from "zod"

/** The wire protocols the router speaks, on ingress and on egress. */
export const Dialect = z.enum(["anthropic", "openai-chat", "openai-responses"])
export type Dialect = z.infer<typeof Dialect>

/**
 * Which spelling of the Chat Completions output ceiling an upstream accepts.
 *
 * One dialect, two field names, and no upstream takes both. OpenAI renamed `max_tokens` to
 * `max_completion_tokens` and its reasoning models (`o1`, `o3`, `o4-mini`, `gpt-5`) now **reject**
 * the old name outright — `400 Unsupported parameter`. Most compatible vendors state only the old
 * one, and an OpenAI-compatible server that has never heard of the new one does the worse thing: it
 * ignores the field and generates to its own default, so the ceiling the caller set disappears
 * without an error anyone can see.
 *
 * So it is a fact about the **provider**, declared by its driver, and never guessed from a model
 * name — `openai/o3` reached through OpenRouter is addressed the way OpenRouter states, not the way
 * the model's own vendor does. Read only when the router *writes* an openai-chat body, which is to
 * say on a cross-dialect translation; a same-dialect request is bytes the router does not open.
 */
export const OpenAiChatCeiling = z.enum(["max_tokens", "max_completion_tokens"])
export type OpenAiChatCeiling = z.infer<typeof OpenAiChatCeiling>

/** What an upstream gets when its driver states nothing: the name every compatible vendor knows. */
export const DEFAULT_OPENAI_CHAT_CEILING: OpenAiChatCeiling = "max_tokens"

/**
 * How a request reaches its upstream, decided per request from the ingress dialect and the
 * selected Account:
 *
 * - `passthrough` — same dialect. Headers swapped, body opaque, stream forwarded byte for byte.
 * - `translate` — HTTP driver, dialects differ. An explicit, documented conversion pair.
 * - `agent-sdk` — Claude subscription accounts. SDK output re-synthesized into the ingress
 *   dialect. Nominally same-dialect against Anthropic ingress, but still a re-synthesis and
 *   never a passthrough.
 */
export const EgressMode = z.enum(["passthrough", "translate", "agent-sdk"])
export type EgressMode = z.infer<typeof EgressMode>
