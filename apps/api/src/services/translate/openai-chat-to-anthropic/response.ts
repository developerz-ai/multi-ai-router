import type {
  AnthropicTextBlock,
  AnthropicThinkingBlock,
  AnthropicToolUseBlock,
} from "../shared/anthropic"
import { readOpenAiChatReasoning } from "../shared/openai-chat-reasoning"
import { openAiChatCompletionSchema } from "../shared/openai-chat-wire"
import { type TranslatedResponse, undecodableToolArguments } from "../shared/response"
import { ROUTER_THINKING_SIGNATURE } from "../shared/router-thinking"
import { toAnthropicStopReason } from "../shared/stop-reason"
import { upstreamToolInput } from "../shared/tools"
import { anthropicUsageCounts, parseOpenAiChatUsage } from "../shared/usage"

/**
 * A non-streaming `chat.completion` object → an Anthropic `Message`.
 *
 * The mirror of `stream.ts` for the request that did not ask to stream, and — like it — this is the
 * direction that has to **invent structure**: openai-chat states one flat `content` string and a
 * separate `tool_calls[]`, while Anthropic states an ordered array of blocks. A reasoning model's
 * thinking is emitted first, as a `thinking` block signed with the router's tag — the same row as
 * its streaming half — then text, then one `tool_use` block per call, which is the order they
 * arrive in on the wire. Replayed, the tagged block is dropped by every `anthropic → X` request
 * translator (`06-protocol-translation.md#known-lossy-edges`).
 *
 * **Nothing here throws.** The upstream already answered, so a malformed field is reported as
 * absent rather than thrown (`docs/idea/06-protocol-translation.md`, "Rejected: nothing at stream
 * time"). The one exception is a tool call whose `arguments` do not decode to an object: Anthropic's
 * `input` has no form for it, and an invented `{}` is a call the client would run with arguments the
 * model never wrote, so the result carries `translationFailure` and the caller answers with an
 * error instead of the body.
 */

export interface OpenAiChatToAnthropicResponseOptions {
  /** Used when the upstream body names no id of its own. */
  readonly id?: string | undefined
  /** Used when the upstream body names no model. The client's requested name is the right value. */
  readonly model?: string | undefined
}

export function openAiChatToAnthropicResponse(
  body: unknown,
  options: OpenAiChatToAnthropicResponseOptions = {},
): TranslatedResponse {
  const parsed = openAiChatCompletionSchema.safeParse(body)
  const completion = parsed.success ? parsed.data : null

  // `n > 1` is refused at request time, so the one choice a translated response can carry is the
  // first; an upstream that answered with more anyway has its extras dropped, never interleaved.
  const choice = (completion?.choices ?? []).find((entry) => (entry.index ?? 0) === 0)

  const content: (AnthropicTextBlock | AnthropicThinkingBlock | AnthropicToolUseBlock)[] = []
  // Router-signed, as the stream half is (`stream.ts`); an empty one is no block, which Anthropic rejects.
  const thinking = readOpenAiChatReasoning(choice?.message)
  if (thinking.length > 0)
    content.push({ type: "thinking", thinking, signature: ROUTER_THINKING_SIGNATURE })
  const text = choice?.message?.content ?? ""
  // Anthropic rejects an empty text block, and a completion that was only a tool call said nothing.
  if (text.length > 0) content.push({ type: "text", text })
  let translationFailure: TranslatedResponse["translationFailure"]
  for (const [index, call] of (choice?.message?.tool_calls ?? []).entries()) {
    const input = upstreamToolInput(call.function?.arguments)
    translationFailure ??= input === null ? undecodableToolArguments(index) : undefined
    content.push({
      type: "tool_use",
      id: call.id ?? "",
      name: call.function?.name ?? "",
      input: input ?? {},
    })
  }

  const stop = toAnthropicStopReason(choice?.finish_reason)

  return {
    body: {
      id: completion?.id ?? options.id ?? "",
      type: "message",
      role: "assistant",
      model: completion?.model ?? options.model ?? "",
      content,
      stop_reason:
        content.some((block) => block.type === "tool_use") &&
        (choice?.finish_reason == null || choice.finish_reason === "stop")
          ? "tool_use"
          : stop.value,
      // Lossy, and documented: openai-chat has no field naming *which* stop sequence matched.
      stop_sequence: null,
      usage: anthropicUsageCounts(parseOpenAiChatUsage(completion?.usage)),
    },
    unrecognizedStopReason: stop.unrecognized,
    ...(translationFailure === undefined ? {} : { translationFailure }),
  }
}
