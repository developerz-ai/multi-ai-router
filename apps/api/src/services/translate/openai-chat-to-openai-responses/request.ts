import type {
  ParsedOpenAiChatContent,
  ParsedOpenAiChatRequest,
  ParsedOpenAiChatToolCall,
} from "../shared/openai-chat"
import { openAiChatRequestSchema } from "../shared/openai-chat"
import type {
  OpenAiResponsesItem,
  OpenAiResponsesPart,
  OpenAiResponsesRequest,
} from "../shared/openai-responses"
import {
  assertNoStopSequence,
  assertPlainResponseFormat,
  parseRequest,
  rejectField,
} from "../shared/reject"
import { toolChoiceToOpenAiResponses, toolsToOpenAiResponses } from "../shared/tools"

/**
 * Chat Completions body → a `POST /v1/responses` body. Pure: no clock, no store, no network, no
 * logger (docs/idea/06-protocol-translation.md#design-rules).
 *
 * **Responses takes a flat list of items and requires no alternation**, so unlike the anthropic
 * direction nothing here is reshaped: consecutive same-role messages stay separate items. Merging
 * them is owed to Anthropic, which demands `user`/`assistant` alternation; doing it here would
 * rewrite a transcript the caller composed for a dialect that asked for nothing of the sort. Every
 * openai-chat message becomes exactly one item, plus one `function_call` item per `tool_calls[]`
 * entry, in the order they arrived.
 *
 * Where role *does* matter is the text part: an input turn spells its text `input_text` and the
 * model's own earlier output spells it `output_text`. Responses states the two apart, so this
 * translator has to as well.
 *
 * **`reasoning_effort` and `parallel_tool_calls` are carried, not dropped**, because this is the one
 * pair where both sides state them: openai-chat's `reasoning_effort` is openai-responses'
 * `reasoning.effort` under a flatter name, and `parallel_tool_calls` is spelled identically. The
 * effort word travels **verbatim** — the two dialects share one vocabulary, and mapping it through a
 * table of ours would let a value OpenAI adds later arrive as one it already understood.
 *
 * Refused: `logprobs`, `top_logprobs`, `n > 1`, `stop`, `response_format`, audio and file parts, a
 * non-text part in a system message or a tool result, and a `tool_call_id` matching no call earlier
 * in the transcript. Dropped, as documented: `seed`, `frequency_penalty`, `presence_penalty`,
 * `logit_bias`, `user`, `strict`, and image `detail`.
 */

/** Several system turns become one `instructions` string, and multi-part text joins the same way. */
const TEXT_JOIN = "\n\n"

/** @throws TranslationError (400) naming the field that has no openai-responses representation. */
export function openAiChatToOpenAiResponsesRequest(body: unknown): OpenAiResponsesRequest {
  const request = parseRequest(openAiChatRequestSchema, body, "openai-chat")
  assertTranslatableToOpenAiResponses(request)

  const instructions: string[] = []
  const input: OpenAiResponsesItem[] = []
  // Ids seen on an assistant message, so a result naming a call that never happened is refused
  // rather than handed upstream to fail there with a message about a body we wrote.
  const calls = new Set<string>()

  for (const [index, message] of request.messages.entries()) {
    const at = `messages[${index}]`
    switch (message.role) {
      case "system":
      case "developer": {
        // Responses has one top-level `instructions`, wherever openai-chat put its system turns.
        const text = contentText(message.content, at, "instruction")
        if (text.length > 0) instructions.push(text)
        break
      }
      case "user":
        pushMessage(input, "user", contentParts(message.content, "input_text", at))
        break
      case "assistant": {
        const parts = contentParts(message.content ?? undefined, "output_text", at)
        pushMessage(input, "assistant", parts)
        for (const call of message.tool_calls ?? []) {
          calls.add(call.id)
          input.push(functionCall(call))
        }
        break
      }
      case "tool":
        if (!calls.has(message.tool_call_id)) {
          rejectField(
            `${at}.tool_call_id`,
            "matches no `tool_calls` entry earlier in the transcript, so it has no `function_call` item to attach to",
          )
        }
        input.push({
          type: "function_call_output",
          call_id: message.tool_call_id,
          output: contentText(message.content, at, "function call output"),
        })
        break
    }
  }

  return {
    model: request.model,
    input,
    instructions: instructions.length === 0 ? undefined : instructions.join(TEXT_JOIN),
    max_output_tokens: request.max_completion_tokens ?? request.max_tokens ?? undefined,
    temperature: request.temperature ?? undefined,
    top_p: request.top_p ?? undefined,
    stream: request.stream ?? undefined,
    tools: request.tools === undefined ? undefined : toolsToOpenAiResponses(request.tools),
    tool_choice:
      request.tool_choice === undefined
        ? undefined
        : toolChoiceToOpenAiResponses(request.tool_choice),
    parallel_tool_calls: request.parallel_tool_calls ?? undefined,
    // The nesting is the only difference between the two spellings, so the word itself is untouched.
    reasoning:
      typeof request.reasoning_effort === "string"
        ? { effort: request.reasoning_effort }
        : undefined,
    // Never the caller's value: an openai-chat client has no way to name a stored response on its
    // next turn, so one left behind is litter on the provider that nobody can reference or delete.
    store: false,
  }
}

const NO_COUNTERPART =
  "has no openai-responses counterpart; it is refused rather than silently ignored"

/**
 * The five openai-chat fields this direction refuses.
 *
 * Each is a *contract* rather than a hint: a caller that asked for `logprobs` and got a body without
 * them was answered a different question than the one it asked, and `n > 1` is the same in a louder
 * way — a caller expecting four completions cannot use one. `stop` is the fourth and is refused by
 * `shared/reject.ts`, which states the rule once for both dialects that spell it.
 *
 * `response_format` is the odd one out, because openai-responses *does* state the same feature —
 * under `text.format`, nested differently. It is refused all the same: the doctrine is one rule in
 * both directions (`06-protocol-translation.md#known-lossy-edges`), and honoring it here while the
 * reverse pair refuses it would make "servable" depend on which way the request happened to point.
 */
function assertTranslatableToOpenAiResponses(request: ParsedOpenAiChatRequest): void {
  if (request.logprobs === true) rejectField("logprobs", NO_COUNTERPART)
  if (typeof request.top_logprobs === "number") rejectField("top_logprobs", NO_COUNTERPART)
  if (typeof request.n === "number" && request.n > 1) {
    rejectField(
      "n",
      "> 1 has no openai-responses counterpart: one request yields exactly one response",
    )
  }
  assertNoStopSequence(request.stop, "stop")
  assertPlainResponseFormat(request)
}

function functionCall(call: ParsedOpenAiChatToolCall): OpenAiResponsesItem {
  return {
    type: "function_call",
    // Ids pass through verbatim: minting one here breaks the pairing with the result that follows.
    call_id: call.id,
    name: call.function.name,
    // openai-chat lets a no-argument call omit `arguments` and Responses requires the field. The
    // empty string carries that absence; `{}` would state arguments the caller never sent.
    arguments: call.function.arguments ?? "",
  }
}

/** A message that translated to nothing is dropped: an item with no content states nothing, and an
 * assistant turn that carried only calls states them as items of their own. */
function pushMessage(
  input: OpenAiResponsesItem[],
  role: "user" | "assistant",
  content: readonly OpenAiResponsesPart[],
): void {
  if (content.length === 0) return
  input.push({ type: "message", role, content })
}

function contentParts(
  content: ParsedOpenAiChatContent | undefined,
  kind: "input_text" | "output_text",
  at: string,
): OpenAiResponsesPart[] {
  if (content === undefined) return []
  if (typeof content === "string") {
    // An empty openai-chat content string is simply no content, and an empty part says nothing.
    return content.length === 0 ? [] : [{ type: kind, text: content }]
  }

  const parts: OpenAiResponsesPart[] = []
  for (const [index, part] of content.entries()) {
    const field = `${at}.content[${index}]`
    switch (part.type) {
      case "text":
        if (part.text.length > 0) parts.push({ type: kind, text: part.text })
        break
      case "image_url":
        // `input_image` whatever the turn's role: Responses spells only *text* apart by direction,
        // and an image the caller attached is content, not something to lose over a role.
        parts.push({ type: "input_image", image_url: part.image_url.url })
        break
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no openai-responses counterpart`)
    }
  }
  return parts
}

/**
 * The plain text of a message, for the two places Responses holds text and nothing else: the
 * top-level `instructions`, and a `function_call_output`.
 *
 * @throws TranslationError (400) when a part has no text form, rather than dropping it — an image a
 * caller attached to a tool result is content, and losing it quietly answers a different question.
 */
function contentText(
  content: ParsedOpenAiChatContent | undefined,
  at: string,
  purpose: string,
): string {
  const texts: string[] = []
  // The kind asked for never reaches the body here: only the text of each part is kept.
  for (const part of contentParts(content, "input_text", at)) {
    if (part.type === "input_image") {
      rejectField(
        `${at}.content`,
        `carries a non-text part, which an openai-responses ${purpose} cannot hold`,
      )
    }
    texts.push(part.text)
  }
  return texts.join(TEXT_JOIN)
}

/** `stop: []` and `stop: ""` name no sequence at all; only a stated one is worth a refusal. */
