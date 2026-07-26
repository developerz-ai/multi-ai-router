import type { OpenAiChatCeiling } from "@multi-ai-router/core"
import type {
  OpenAiChatMessage,
  OpenAiChatPart,
  OpenAiChatRequest,
  OpenAiChatToolCall,
} from "../shared/openai-chat"
import { chatCeiling } from "../shared/openai-chat"
import type {
  ParsedOpenAiResponsesContent,
  ParsedOpenAiResponsesItem,
  ParsedOpenAiResponsesPart,
} from "../shared/openai-responses"
import { openAiResponsesRequestSchema, UNSUPPORTED } from "../shared/openai-responses"
import {
  assertPlainTextFormat,
  assertStatelessResponses,
  parseRequest,
  rejectField,
  rejectStatefulItem,
} from "../shared/reject"
import { toolChoiceFromOpenAiResponses, toolsFromOpenAiResponses } from "../shared/tools"

/**
 * `POST /v1/responses` body → a Chat Completions body. Pure: no clock, no store, no network, no
 * logger (docs/idea/06-protocol-translation.md#design-rules).
 *
 * This is the pair the matrix calls a **downgrade** — the richer dialect expressed in the poorer one
 * (`06-protocol-translation.md#translation-matrix`, legend). Responses states a *stateful*
 * conversation of typed items, a reasoning dial, and a response-shape constraint; openai-chat states
 * a flat message list and nothing else. Every difference is either refused by name or named below as
 * a documented drop, and none of it is quietly approximated.
 *
 * **The stateful half is a `400` before any upstream call, and that is the headline of this
 * direction.** `previous_response_id`, `store: true`, `include`, `conversation`, `prompt`,
 * `background: true`, and `reasoning` / `item_reference` items all mean "continue from, or leave
 * behind, something the provider remembers", and this router remembers
 * nothing — it picks an account per request. Served anyway, a `previous_response_id` would become a
 * call carrying only the newest turn and the model would answer a conversation it was never shown,
 * so the refusal names the field and the client learns to send the whole transcript instead.
 * `text.format` is refused on the same terms: a schema-constrained answer is a contract the caller
 * will parse, not a hint.
 *
 * **Consecutive same-role items are deliberately not merged**, which is the one structural
 * difference from the `anthropic-to-openai-chat` sibling. Each Responses item is already exactly one
 * message, so the item list *is* the message list, and folding two of them would rewrite a
 * transcript the caller composed. The sibling merges because Anthropic states several content blocks
 * per turn — the opposite problem.
 *
 * Dropped, as documented: `reasoning.effort`. This build's openai-chat emit shape carries no effort
 * field, and a dropped *hint* is a documented loss where a dropped *contract* would be a bug.
 * Refused: built-in tools, an image the caller only stored a `file_id` for, a `function_call_output`
 * naming a call that never happened, and any item or content part with no chat counterpart.
 */

/** Parts inside one item join the way `shared/responses-read.ts` joins them on the way back. */
const PART_JOIN = "\n"

/** What a refusal calls the message a Responses item lands in on this side. */
const SYSTEM_CARRIER = 'an openai-chat `role:"system"` message'
const ASSISTANT_CARRIER = 'an openai-chat `role:"assistant"` message'
const TOOL_CARRIER = 'an openai-chat `role:"tool"` message'

/**
 * A stored file is provider-side state one level below `previous_response_id`, and it is refused for
 * the same reason: the router resolves nothing against a provider it holds no session with.
 */
const STORED_FILE =
  "names a file stored inside openai-responses, which this router cannot resolve: it holds no provider-side state, and an openai-chat image part carries a URL and nothing else"

/** The message shape every `message` item lands in, whatever role it states. */
interface ParsedMessageItem {
  readonly role: "user" | "assistant" | "system" | "developer"
  readonly content: ParsedOpenAiResponsesContent
}

export interface OpenAiResponsesToOpenAiChatOptions {
  /** Which spelling of the output ceiling the selected Account accepts. Defaults to `max_tokens`. */
  readonly ceiling?: OpenAiChatCeiling | undefined
}

/** @throws TranslationError (400) naming the field that has no openai-chat representation. */
export function openAiResponsesToOpenAiChatRequest(
  body: unknown,
  options: OpenAiResponsesToOpenAiChatOptions = {},
): OpenAiChatRequest {
  const request = parseRequest(openAiResponsesRequestSchema, body, "openai-responses")
  assertStatelessResponses(request)
  assertPlainTextFormat(request)

  const messages: OpenAiChatMessage[] = []
  const instructions = request.instructions ?? ""
  if (instructions.length > 0) messages.push({ role: "system", content: instructions })

  if (typeof request.input === "string") {
    // The bare-string shorthand every Responses client writes: one user turn and nothing else.
    messages.push({ role: "user", content: request.input })
  } else {
    // Call ids seen on a `function_call` item, so an output answering a call that never happened is
    // refused here rather than upstream, where it would fail with a message about a body we wrote.
    const calls = new Set<string>()
    for (const [index, item] of request.input.entries()) {
      appendItem(messages, calls, item, `input[${index}]`)
    }
  }

  if (messages.length === 0) {
    rejectField("input", "carries no message: an openai-chat request needs at least one")
  }

  // `undefined` members are dropped by `JSON.stringify` on the way out, so an absent field stays
  // absent rather than becoming an explicit null the upstream has to interpret.
  return {
    model: request.model,
    messages,
    // `max_output_tokens` is Responses' name for the same ceiling; which of openai-chat's two names
    // it lands under is the target's answer, not ours.
    ...chatCeiling(request.max_output_tokens ?? undefined, options.ceiling),
    temperature: request.temperature ?? undefined,
    top_p: request.top_p ?? undefined,
    stream: request.stream ?? undefined,
    // Without this an OpenAI stream reports no usage at all, and the terminal events we synthesize
    // back toward the client would have to carry null tokens every time.
    stream_options: request.stream === true ? { include_usage: true } : undefined,
    tools: request.tools === undefined ? undefined : toolsFromOpenAiResponses(request.tools),
    tool_choice:
      request.tool_choice === undefined
        ? undefined
        : toolChoiceFromOpenAiResponses(request.tool_choice),
  }
}

function appendItem(
  messages: OpenAiChatMessage[],
  calls: Set<string>,
  item: ParsedOpenAiResponsesItem,
  at: string,
): void {
  if (item.type === "reasoning" || item.type === "item_reference") {
    rejectStatefulItem(at, item.type)
  }

  if (item.type === "function_call") {
    calls.add(item.call_id)
    // Ids are preserved verbatim: a minted one breaks the call ↔ output pairing on the next turn.
    const call: OpenAiChatToolCall = {
      id: item.call_id,
      type: "function",
      function: { name: item.name, arguments: item.arguments ?? "" },
    }
    messages.push({ role: "assistant", tool_calls: [call] })
    return
  }

  if (item.type === "function_call_output") {
    if (!calls.has(item.call_id)) {
      rejectField(
        `${at}.call_id`,
        "matches no `function_call` item earlier in the transcript, so it answers no tool call",
      )
    }
    const content = contentText(item.output, `${at}.output`, TOOL_CARRIER)
    messages.push({ role: "tool", tool_call_id: item.call_id, content })
    return
  }

  if (item.type === UNSUPPORTED) {
    rejectField(`${at}.type`, `\`${item.actual}\` has no openai-chat counterpart`)
  }

  appendMessage(messages, item, at)
}

/** Only a `user` turn keeps a multi-part body; the other two roles are text on this side. */
function appendMessage(messages: OpenAiChatMessage[], item: ParsedMessageItem, at: string): void {
  const field = `${at}.content`

  if (item.role === "system" || item.role === "developer") {
    // `developer` is the same instruction under the newer name, and openai-chat's own emit shape
    // spells it `system` — the one name every compatible upstream accepts.
    messages.push({ role: "system", content: contentText(item.content, field, SYSTEM_CARRIER) })
    return
  }
  if (item.role === "assistant") {
    const content = contentText(item.content, field, ASSISTANT_CARRIER)
    messages.push({ role: "assistant", content })
    return
  }
  messages.push({ role: "user", content: collapse(userParts(item.content, field)) })
}

function userParts(content: ParsedOpenAiResponsesContent, at: string): OpenAiChatPart[] {
  if (typeof content === "string") {
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }

  const parts: OpenAiChatPart[] = []
  for (const [index, part] of content.entries()) {
    const field = `${at}[${index}]`
    switch (part.type) {
      case "input_text":
      case "output_text":
        if (part.text.length > 0) parts.push({ type: "text", text: part.text })
        break
      case "refusal":
        // Carried as text: the model declined out loud on an earlier turn, and dropping the sentence
        // it declined with would replay the conversation as though it had said nothing.
        if (part.refusal.length > 0) parts.push({ type: "text", text: part.refusal })
        break
      case "input_image":
        parts.push({ type: "image_url", image_url: { url: imageUrl(part, field) } })
        break
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no openai-chat counterpart`)
    }
  }
  return parts
}

/** The text of a content value, for the three carriers that hold text and nothing else. */
function contentText(
  content: ParsedOpenAiResponsesContent | undefined,
  at: string,
  carrier: string,
): string {
  if (content === undefined) return ""
  if (typeof content === "string") return content

  const texts: string[] = []
  for (const [index, part] of content.entries()) {
    texts.push(partText(part, `${at}[${index}]`, carrier))
  }
  return texts.join(PART_JOIN)
}

/**
 * @throws TranslationError (400) when the part has no text form, rather than dropping it — an image
 * the caller attached is content, and losing it quietly answers a different question.
 */
function partText(part: ParsedOpenAiResponsesPart, at: string, carrier: string): string {
  if (part.type === "input_text" || part.type === "output_text") return part.text
  if (part.type === "refusal") return part.refusal
  if (part.type === "input_image") {
    rejectField(`${at}.type`, `\`input_image\` cannot be carried in ${carrier}, which is text only`)
  }
  rejectField(`${at}.type`, `\`${part.actual}\` has no openai-chat counterpart`)
}

/** @throws TranslationError (400) when the part names no URL an openai-chat image part can hold. */
function imageUrl(
  part: { readonly image_url?: string | null; readonly file_id?: string | null },
  at: string,
): string {
  const url = part.image_url ?? ""
  if (url.length > 0) return url
  if ((part.file_id ?? "").length > 0) rejectField(`${at}.file_id`, STORED_FILE)
  rejectField(`${at}.image_url`, "is absent: an openai-chat image part is a URL")
}

/** A lone text part is emitted as a plain string — the shape every compatible upstream accepts. */
function collapse(parts: readonly OpenAiChatPart[]): string | readonly OpenAiChatPart[] {
  if (parts.length === 0) return ""
  const only = parts[0]
  if (parts.length === 1 && only !== undefined && only.type === "text") return only.text
  return parts
}
