import type { OpenAiChatCeiling } from "@multi-ai-router/core"
import { type DropSink, IGNORE_DROPS } from "../shared/drops"
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
} from "../shared/openai-responses"
import { openAiResponsesRequestSchema, UNSUPPORTED } from "../shared/openai-responses"
import {
  assertPlainTextFormat,
  assertStatelessResponses,
  dropEncryptedReasoning,
  parseRequest,
  rejectField,
  rejectStatefulItem,
} from "../shared/reject"
import {
  collapse,
  contentText,
  imageUrl,
  PART_JOIN,
  partText,
  userParts,
} from "../shared/responses-chat-content"
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
 * `background: true`, and `item_reference` items all mean "continue from, or leave behind,
 * something the provider remembers", and this router remembers
 * nothing — it picks an account per request. Served anyway, a `previous_response_id` would become a
 * call carrying only the newest turn and the model would answer a conversation it was never shown,
 * so the refusal names the field and the client learns to send the whole transcript instead.
 * `text.format` is refused on the same terms: a schema-constrained answer is a contract the caller
 * will parse, not a hint.
 *
 * Assistant text and adjacent function calls share one assistant turn; ordinary same-role
 * messages remain separate. Tool replies stay keyed and images follow the complete reply run.
 * Reasoning items are dropped: a summary is a stateless hint, and an encrypted handle — account-bound
 * and unreadable by any chat upstream — is reported through `options.onDrop` along with
 * `include: ["reasoning.encrypted_content"]`. Neither hides a turn, so neither is refused.
 *
 * **`reasoning.effort` and `parallel_tool_calls` survive the downgrade**, because they are the two
 * dials openai-chat states too — `reasoning_effort` is the same word one level flatter. The effort
 * word travels **verbatim**: the two dialects share one vocabulary, and remapping it through a table
 * of ours would let a value OpenAI adds later arrive as one it already understood. `reasoning.summary`
 * has no counterpart and is dropped — it asks the provider to *write* a summary of its own reasoning,
 * which openai-chat cannot request.
 *
 * Refused: built-in tools, an image the caller only stored a `file_id` for, a `function_call_output`
 * naming a call that never happened, and any item or content part with no chat counterpart.
 */

/** What a refusal calls the message a Responses item lands in on this side. */
const SYSTEM_CARRIER = 'an openai-chat `role:"system"` message'
const ASSISTANT_CARRIER = 'an openai-chat `role:"assistant"` message'
const TOOL_CARRIER = 'an openai-chat `role:"tool"` message'

/** The message shape every `message` item lands in, whatever role it states. */
interface ParsedMessageItem {
  readonly role: "user" | "assistant" | "system" | "developer"
  readonly content: ParsedOpenAiResponsesContent
}

export interface OpenAiResponsesToOpenAiChatOptions {
  /** Which spelling of the output ceiling the selected Account accepts. Defaults to `max_tokens`. */
  readonly ceiling?: OpenAiChatCeiling | undefined
  /** Where a dropped field is reported. Absent, drops are silent (`shared/drops.ts`). */
  readonly onDrop?: DropSink | undefined
}

/** @throws TranslationError (400) naming the field that has no openai-chat representation. */
export function openAiResponsesToOpenAiChatRequest(
  body: unknown,
  options: OpenAiResponsesToOpenAiChatOptions = {},
): OpenAiChatRequest {
  const request = parseRequest(openAiResponsesRequestSchema, body, "openai-responses")
  const onDrop = options.onDrop ?? IGNORE_DROPS
  assertStatelessResponses(request, onDrop)
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
    const hoisted: OpenAiChatPart[] = []
    const flushImages = () => {
      if (hoisted.length > 0) messages.push({ role: "user", content: hoisted.splice(0) })
    }
    for (const [index, item] of request.input.entries()) {
      if (item.type === "reasoning") {
        dropEncryptedReasoning(item, `input[${index}]`, onDrop)
        continue
      }
      if (item.type !== "function_call_output") flushImages()
      appendItem(messages, calls, item, `input[${index}]`, hoisted)
    }
    flushImages()
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
    parallel_tool_calls: request.parallel_tool_calls ?? undefined,
    // The nesting is the only difference between the two spellings, so the word itself is untouched.
    reasoning_effort: request.reasoning?.effort ?? undefined,
  }
}

function appendItem(
  messages: OpenAiChatMessage[],
  calls: Set<string>,
  item: ParsedOpenAiResponsesItem,
  at: string,
  hoisted: OpenAiChatPart[],
): void {
  // `reasoning` never reaches here: the caller drops it before an item is appended.
  if (item.type === "reasoning") return
  if (item.type === "item_reference") {
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
    const previous = messages.at(-1)
    if (previous?.role === "assistant") {
      messages[messages.length - 1] = {
        ...previous,
        tool_calls: [...(previous.tool_calls ?? []), call],
      }
    } else messages.push({ role: "assistant", tool_calls: [call] })
    return
  }

  if (item.type === "function_call_output") {
    if (!calls.has(item.call_id)) {
      rejectField(
        `${at}.call_id`,
        "matches no `function_call` item earlier in the transcript, so it answers no tool call",
      )
    }
    const output = item.output
    const texts: string[] = []
    if (Array.isArray(output))
      for (const [index, part] of output.entries()) {
        const field = `${at}.output[${index}]`
        if (part.type === "input_image")
          hoisted.push({ type: "image_url", image_url: { url: imageUrl(part, field) } })
        else texts.push(partText(part, field, TOOL_CARRIER))
      }
    const content = typeof output === "string" ? output : texts.join(PART_JOIN)
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
    const previous = messages.at(-1)
    if (previous?.role === "assistant" && previous.tool_calls !== undefined) {
      messages[messages.length - 1] = {
        ...previous,
        content: [previous.content, content].filter(Boolean).join(PART_JOIN),
      }
    } else messages.push({ role: "assistant", content })
    return
  }
  messages.push({ role: "user", content: collapse(userParts(item.content, field)) })
}
