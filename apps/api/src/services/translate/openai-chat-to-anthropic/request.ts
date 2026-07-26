import type { AnthropicBlock, AnthropicRequest } from "../shared/anthropic"
import { DEFAULT_MAX_TOKENS } from "../shared/anthropic"
import type { AnthropicTurn } from "../shared/anthropic-turns"
import {
  BLOCK_JOIN,
  blocksText,
  imageBlockFromUrl,
  mergeTurns,
  pushTurn,
} from "../shared/anthropic-turns"
import type {
  ParsedOpenAiChatContent,
  ParsedOpenAiChatRequest,
  ParsedOpenAiChatToolCall,
} from "../shared/openai-chat"
import { openAiChatRequestSchema } from "../shared/openai-chat"
import {
  assertPlainResponseFormat,
  assertTranslatableToAnthropic,
  parseRequest,
  rejectField,
} from "../shared/reject"
import { inputFromArguments, toolChoiceToAnthropic, toolsToAnthropic } from "../shared/tools"

/**
 * Chat Completions body → a `POST /v1/messages` body. Pure: no clock, no store, no network, no
 * logger (docs/idea/06-protocol-translation.md#design-rules).
 *
 * **Anthropic requires strict `user`/`assistant` alternation and OpenAI does not**, so this
 * direction is where the transcript is reshaped. Consecutive same-role turns are **merged**, never
 * reordered (`06-protocol-translation.md:119-121`): merging concatenates content the model was
 * already going to read in that order, while reordering would change what it was told. Every
 * `role:"tool"` message becomes a `tool_result` block on a **user** turn, which is where Anthropic
 * puts results — several in a row therefore merge into one turn, exactly as Anthropic expects.
 *
 * **`reasoning_effort` is dropped here and carried toward openai-responses**, and the asymmetry is
 * the point: Anthropic's extended thinking is a **token budget**, not an effort word, so turning
 * `"high"` into a `budget_tokens` would invent both what the caller pays and how long the answer
 * takes. The same drop is stated in the mirror direction for `reasoning.effort`
 * (`06-protocol-translation.md#known-lossy-edges`), so the loss does not depend on which way the
 * request happened to point.
 *
 * Refused: `logprobs`, `top_logprobs`, `n > 1`, a `response_format` constraining the answer's shape,
 * audio and file parts, and a `tool_call_id` matching no call earlier in the transcript. Dropped, as
 * documented: `seed`, `frequency_penalty`, `presence_penalty`, `logit_bias`, `user`,
 * `reasoning_effort`, `parallel_tool_calls`, `strict`, and image `detail`.
 */

export interface OpenAiChatToAnthropicOptions {
  readonly defaultMaxTokens?: number | undefined
}

/** @throws TranslationError (400) naming the field that has no anthropic representation. */
export function openAiChatToAnthropicRequest(
  body: unknown,
  options: OpenAiChatToAnthropicOptions = {},
): AnthropicRequest {
  const request = parseRequest(openAiChatRequestSchema, body, "openai-chat")
  assertTranslatableToAnthropic(request)
  assertPlainResponseFormat(request)

  const system: string[] = []
  const turns: AnthropicTurn[] = []
  // Ids seen on an assistant turn, so a result naming a call that never happened is refused rather
  // than handed upstream to fail there with a message about a body we wrote.
  const calls = new Set<string>()

  for (const [index, message] of request.messages.entries()) {
    const at = `messages[${index}]`
    switch (message.role) {
      case "system":
      case "developer": {
        // Anthropic has one top-level system prompt, wherever OpenAI put its system turns.
        const text = contentText(message.content, at, "system prompt")
        if (text.length > 0) system.push(text)
        break
      }
      case "user":
        pushTurn(turns, "user", contentBlocks(message.content, at))
        break
      case "assistant":
        pushTurn(
          turns,
          "assistant",
          assistantBlocks(message.content, message.tool_calls, calls, at),
        )
        break
      case "tool":
        if (!calls.has(message.tool_call_id)) {
          rejectField(
            `${at}.tool_call_id`,
            "matches no `tool_calls` entry earlier in the transcript, so it has no `tool_use` block to attach to",
          )
        }
        pushTurn(turns, "user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: contentText(message.content, at, "tool result"),
          },
        ])
        break
    }
  }

  const messages = mergeTurns(turns)
  if (messages.length === 0) {
    rejectField("messages", "carries no user or assistant turn: an anthropic request needs one")
  }

  return {
    model: request.model,
    messages,
    max_tokens:
      request.max_completion_tokens ??
      request.max_tokens ??
      options.defaultMaxTokens ??
      DEFAULT_MAX_TOKENS,
    system: system.length === 0 ? undefined : system.join(BLOCK_JOIN),
    temperature: request.temperature ?? undefined,
    top_p: request.top_p ?? undefined,
    stop_sequences: stopSequences(request.stop),
    stream: request.stream ?? undefined,
    tools: request.tools === undefined ? undefined : toolsToAnthropic(request.tools),
    tool_choice:
      request.tool_choice === undefined ? undefined : toolChoiceToAnthropic(request.tool_choice),
  }
}

function assistantBlocks(
  content: ParsedOpenAiChatContent | null | undefined,
  toolCalls: readonly ParsedOpenAiChatToolCall[] | undefined,
  calls: Set<string>,
  at: string,
): AnthropicBlock[] {
  const blocks = contentBlocks(content ?? undefined, at)
  for (const [index, call] of (toolCalls ?? []).entries()) {
    calls.add(call.id)
    blocks.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: inputFromArguments(
        call.function.arguments,
        `${at}.tool_calls[${index}].function.arguments`,
      ),
    })
  }
  return blocks
}

function contentBlocks(content: ParsedOpenAiChatContent | undefined, at: string): AnthropicBlock[] {
  if (content === undefined) return []
  if (typeof content === "string") {
    // Anthropic rejects an empty text block; an empty OpenAI content string is simply no content.
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }

  const blocks: AnthropicBlock[] = []
  for (const [index, part] of content.entries()) {
    const field = `${at}.content[${index}]`
    switch (part.type) {
      case "text":
        if (part.text.length > 0) blocks.push({ type: "text", text: part.text })
        break
      case "image_url":
        blocks.push(imageBlockFromUrl(part.image_url.url, `${field}.image_url.url`))
        break
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no anthropic counterpart`)
    }
  }
  return blocks
}

/** A system prompt and a tool result are both plain text on the Anthropic side. */
function contentText(
  content: ParsedOpenAiChatContent | undefined,
  at: string,
  purpose: string,
): string {
  return blocksText(contentBlocks(content, at), `${at}.content`, purpose)
}

function stopSequences(stop: ParsedOpenAiChatRequest["stop"]): readonly string[] | undefined {
  if (stop === null || stop === undefined) return undefined
  const list = typeof stop === "string" ? [stop] : stop
  return list.length === 0 ? undefined : list
}
