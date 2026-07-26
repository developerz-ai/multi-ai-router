import { z } from "zod"

/**
 * Where a reasoning model's thinking text sits on an **openai-chat response**, and which name wins
 * when an upstream states more than one.
 *
 * OpenAI itself defines no such field — a Chat Completions response reports reasoning only as a
 * *count*, `usage.completion_tokens_details.reasoning_tokens`. The text is a vendor extension, and
 * the OpenAI-compatible ecosystem never converged on one spelling: `reasoning_content` (DeepSeek,
 * SGLang, z.ai/GLM, DashScope/Qwen, xAI) and `reasoning` (OpenRouter, Groq, Ollama). A router that
 * reads one of the two loses every model served through the other, so this reads both — and the
 * split is not even stable per vendor: **vLLM emitted `reasoning_content`, then flipped its canonical
 * name to `reasoning`, and spent a release emitting both.** Pinning behaviour to a server version is
 * not something a router can do, and it does not have to.
 *
 * **Read on the way in, never written on the way out.** A dialect this router *emits* is the one its
 * vendor published, and inventing an extension field into an answer is not translation. So a
 * reasoning-model upstream reached over openai-chat has its thinking carried into openai-responses,
 * where the dialect states a reasoning item of its own — and toward `anthropic` and toward an
 * openai-chat client it is a documented drop
 * (`docs/idea/06-protocol-translation.md#known-lossy-edges`).
 *
 * Two shapes are deliberately **not** read here, and both are named in
 * `06-protocol-translation.md#known-lossy-edges` rather than left to be discovered: OpenRouter's
 * structured `reasoning_details[]`, which carries signed blocks a flat string cannot hold, and
 * Mistral's `content: [{type:"thinking", …}]`, which is not a field beside the answer but a shape the
 * answer itself takes.
 *
 * Spread {@link openAiChatReasoningSchema} into whichever `delta` or `message` object a pair already
 * reads; the pair owns its own schema, and this is only the fragment they would otherwise each
 * spell — along with the precedence rule, which is the part two copies could silently disagree on.
 */

/** Both names, read loosely: an upstream that answers with a non-string states nothing readable. */
export const openAiChatReasoningSchema = {
  reasoning_content: z.string().nullish().catch(null),
  reasoning: z.string().nullish().catch(null),
} as const

export interface OpenAiChatReasoningSource {
  readonly reasoning_content?: string | null | undefined
  readonly reasoning?: string | null | undefined
}

/**
 * The thinking text of one delta or message, or `""` when it carries none.
 *
 * `reasoning_content` wins, and which of the two wins is safe rather than lucky: the only server
 * known to state both — vLLM, mid-rename — copies one field into the other, so they are the same
 * string. Concatenating them would double every word the model thought.
 */
export function readOpenAiChatReasoning(
  source: OpenAiChatReasoningSource | null | undefined,
): string {
  return source?.reasoning_content ?? source?.reasoning ?? ""
}
