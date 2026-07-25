import type {
  AnthropicBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
} from "../shared/anthropic"
import type {
  ParsedOpenAiChatContent,
  ParsedOpenAiChatRequest,
  ParsedOpenAiChatToolCall,
} from "../shared/openai-chat"
import { openAiChatRequestSchema } from "../shared/openai-chat"
import { assertTranslatableToAnthropic, parseRequest, rejectField } from "../shared/reject"
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
 * Refused: `logprobs`, `top_logprobs`, `n > 1`, audio and file parts, and a `tool_call_id` matching
 * no call earlier in the transcript. Dropped, as documented: `seed`, `frequency_penalty`,
 * `presence_penalty`, `logit_bias`, `user`, `parallel_tool_calls`, `strict`, and image `detail`.
 */

/**
 * Anthropic requires `max_tokens`; OpenAI's is optional and most clients omit it.
 *
 * A ceiling has to come from somewhere, so it is a parameter with a documented default rather than
 * a constant buried in a branch — the caller supplies the operator's configured value once the
 * translate egress mode is wired, and the default only covers a request that reaches here without
 * one. It is deliberately generous: a low value would truncate answers the client never asked to
 * truncate, which is the one failure a default must not cause silently.
 */
export const DEFAULT_MAX_TOKENS = 4096

export interface OpenAiChatToAnthropicOptions {
  readonly defaultMaxTokens?: number | undefined
}

const BLOCK_JOIN = "\n\n"

/** `data:<media-type>;base64,<payload>` — the only inline image form either dialect spells. */
const DATA_URI = /^data:([^;,]+);base64,([\s\S]*)$/

interface Draft {
  readonly role: "user" | "assistant"
  readonly blocks: AnthropicBlock[]
}

/** @throws TranslationError (400) naming the field that has no anthropic representation. */
export function openAiChatToAnthropicRequest(
  body: unknown,
  options: OpenAiChatToAnthropicOptions = {},
): AnthropicRequest {
  const request = parseRequest(openAiChatRequestSchema, body, "openai-chat")
  assertTranslatableToAnthropic(request)

  const system: string[] = []
  const drafts: Draft[] = []
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
        push(drafts, "user", contentBlocks(message.content, at))
        break
      case "assistant":
        push(drafts, "assistant", assistantBlocks(message.content, message.tool_calls, calls, at))
        break
      case "tool":
        if (!calls.has(message.tool_call_id)) {
          rejectField(
            `${at}.tool_call_id`,
            "matches no `tool_calls` entry earlier in the transcript, so it has no `tool_use` block to attach to",
          )
        }
        push(drafts, "user", [
          {
            type: "tool_result",
            tool_use_id: message.tool_call_id,
            content: contentText(message.content, at, "tool result"),
          },
        ])
        break
    }
  }

  const messages = merge(drafts)
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
        blocks.push(imageBlock(part.image_url.url, `${field}.image_url.url`))
        break
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no anthropic counterpart`)
    }
  }
  return blocks
}

/**
 * A remote URL is **not** fetched and inlined here.
 *
 * A translator is a pure function, and reaching out to an arbitrary URL from inside one would put a
 * network call — and an SSRF surface — on the request path. Anthropic's own `url` image source
 * carries the reference as-is, so the fetch never has to happen; that is what resolves the
 * DEFERRED at `06-protocol-translation.md`'s remote-image row. Anything that is neither a `data:`
 * URI nor http(s) has no source form at all and is refused.
 */
function imageBlock(url: string, at: string): AnthropicImageBlock {
  const inline = DATA_URI.exec(url)
  const mediaType = inline?.[1]
  const data = inline?.[2]
  if (mediaType !== undefined && data !== undefined) {
    return { type: "image", source: { type: "base64", media_type: mediaType, data } }
  }
  if (url.startsWith("https://") || url.startsWith("http://")) {
    return { type: "image", source: { type: "url", url } }
  }
  rejectField(
    at,
    "is neither a base64 `data:` URI nor an http(s) URL, which are the only image sources anthropic accepts",
  )
}

/** A system prompt and a tool result are both plain text on the Anthropic side. */
function contentText(
  content: ParsedOpenAiChatContent | undefined,
  at: string,
  purpose: string,
): string {
  const texts: string[] = []
  for (const block of contentBlocks(content, at)) {
    if (block.type !== "text") {
      rejectField(
        `${at}.content`,
        `carries a non-text part, which an anthropic ${purpose} cannot hold`,
      )
    }
    texts.push(block.text)
  }
  return texts.join(BLOCK_JOIN)
}

function push(drafts: Draft[], role: Draft["role"], blocks: readonly AnthropicBlock[]): void {
  // A turn that translated to nothing is not emitted: Anthropic rejects an empty content array,
  // and an assistant turn with neither text nor a tool call said nothing to begin with.
  if (blocks.length === 0) return
  drafts.push({ role, blocks: [...blocks] })
}

function merge(drafts: readonly Draft[]): AnthropicMessage[] {
  const merged: Draft[] = []
  for (const draft of drafts) {
    const previous = merged.at(-1)
    if (previous !== undefined && previous.role === draft.role) {
      previous.blocks.push(...draft.blocks)
      continue
    }
    merged.push(draft)
  }
  return merged.map((draft) => ({ role: draft.role, content: draft.blocks }))
}

function stopSequences(stop: ParsedOpenAiChatRequest["stop"]): readonly string[] | undefined {
  if (stop === null || stop === undefined) return undefined
  const list = typeof stop === "string" ? [stop] : stop
  return list.length === 0 ? undefined : list
}
