import type { ReasoningSeal } from "../../crypto/reasoning-seal"
import type { AnthropicRedactedThinkingBlock, AnthropicThinkingBlock } from "./anthropic"
import type { OpenAiResponsesReasoningItem } from "./openai-responses"
import { ROUTER_THINKING_SIGNATURE } from "./router-thinking"

/**
 * A Responses reasoning item carried through an Anthropic client and back, for **one account**.
 *
 * A reasoning model's encrypted reasoning item is part of the prompt the upstream caches: drop it
 * from step N+1 and the prefix breaks at step N's output, every step of a tool loop. So when the
 * dataplane hands the translator the selected account's seal (`crypto/reasoning-seal.ts`), the item
 * leaves as an Anthropic block whose signature is the sealed blob — `thinking` when the upstream
 * wrote a summary, `redacted_thinking` (Anthropic's own opaque carrier) when it did not — and the
 * next turn turns that block back into the reasoning item **only if the seal opens it**, which it
 * does for the issuing account alone. Another account's, a tampered one, or the router's plain
 * `mar1:` tag (`router-thinking.ts`, still used wherever no seal or no blob exists) is dropped, as
 * every unsealed thinking block always was. The seal is deterministic, so the replayed item is the
 * same bytes every turn and the upstream prefix cache holds.
 *
 * Pure: the seal is injected, and sealing and opening are deterministic functions of their input.
 */

/** The block a finished reasoning item becomes; null when there is nothing to show or carry. */
export function reasoningBlock(
  summary: string,
  encrypted: string | null,
  seal: ReasoningSeal | undefined,
): AnthropicThinkingBlock | AnthropicRedactedThinkingBlock | null {
  const sealed = seal !== undefined && encrypted !== null ? seal.seal(encrypted) : null
  if (summary.length > 0) {
    return { type: "thinking", thinking: summary, signature: sealed ?? ROUTER_THINKING_SIGNATURE }
  }
  return sealed === null ? null : { type: "redacted_thinking", data: sealed }
}

/** The reasoning item a replayed block stands for, or null when this account's seal refuses it. */
export function replayedReasoningItem(
  summary: string,
  signature: string | undefined,
  seal: ReasoningSeal | undefined,
): OpenAiResponsesReasoningItem | null {
  if (seal === undefined || signature === undefined) return null
  const encrypted = seal.open(signature)
  if (encrypted === null) return null
  return {
    type: "reasoning",
    summary: summary.length === 0 ? [] : [{ type: "summary_text", text: summary }],
    encrypted_content: encrypted,
  }
}
