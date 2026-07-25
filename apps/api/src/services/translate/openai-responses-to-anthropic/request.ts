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
import type { ParsedOpenAiResponsesContent } from "../shared/openai-responses"
import { openAiResponsesRequestSchema, UNSUPPORTED } from "../shared/openai-responses"
import {
  assertPlainTextFormat,
  assertStatelessResponses,
  parseRequest,
  rejectField,
  rejectStatefulItem,
} from "../shared/reject"
import {
  inputFromArguments,
  toolChoiceFromOpenAiResponses,
  toolChoiceToAnthropic,
  toolsFromOpenAiResponses,
  toolsToAnthropic,
} from "../shared/tools"

/**
 * A Responses body → a `POST /v1/messages` body. Pure: no clock, no store, no network, no logger
 * (docs/idea/06-protocol-translation.md#design-rules).
 *
 * **The stateful half of openai-responses is refused here, before any upstream call.**
 * `previous_response_id`, `store: true`, `include`, and `reasoning` / `item_reference` items all say
 * "continue from something the provider is holding for me", and this router holds nothing: it picks
 * an account per request and keeps no conversation state, so on non-Responses egress there is no
 * stored response to continue from at any account it could choose. A `400` naming the field is the
 * only honest answer (`06-protocol-translation.md#translation-matrix`, "Unsupported") — serving the
 * request as though the remembered history were empty answers a different question than the one
 * asked, and the client cannot see from the reply that its transcript was truncated.
 *
 * What is left is the reshaping `openai-chat-to-anthropic/request.ts` also does — **Anthropic
 * requires strict `user`/`assistant` alternation and no OpenAI dialect does**, so consecutive
 * same-role turns are merged and never reordered — plus the flattening Responses alone needs: a
 * transcript is a list of *items*, not messages, so a `function_call` becomes an assistant turn
 * holding a `tool_use` block and its `function_call_output` a user turn holding a `tool_result`,
 * paired by `call_id`.
 *
 * Refused: a stateful field or item, a structured-output `text.format`, an `input_image` that names
 * only a `file_id`, an item or part type with no anthropic counterpart, and a `call_id` matching no
 * call earlier in the transcript. Dropped, as documented: `reasoning.effort` — Anthropic's extended
 * thinking is a **token budget**, not an effort word, and inventing a budget out of one would change
 * both what the caller pays and how long the answer takes. Image `detail` is dropped by the schema.
 */

export interface OpenAiResponsesToAnthropicOptions {
  readonly defaultMaxTokens?: number | undefined
}

/** @throws TranslationError (400) naming the field that has no anthropic representation. */
export function openAiResponsesToAnthropicRequest(
  body: unknown,
  options: OpenAiResponsesToAnthropicOptions = {},
): AnthropicRequest {
  const request = parseRequest(openAiResponsesRequestSchema, body, "openai-responses")
  assertStatelessResponses(request)
  assertPlainTextFormat(request)

  const system: string[] = []
  // `instructions` leads the system prompt: it is the Responses spelling of one, and it applies to
  // the whole request rather than to the point in the transcript a system item happens to sit at.
  const instructions = request.instructions ?? ""
  if (instructions.length > 0) system.push(instructions)

  const turns: AnthropicTurn[] = []
  // Call ids seen on a `function_call`, so an output naming a call that never happened is refused
  // here rather than handed upstream to fail there with a message about a body we wrote.
  const calls = new Set<string>()

  if (typeof request.input === "string") {
    // The shorthand: a bare string is one user turn, exactly as `{role:"user", content}` would be.
    pushTurn(turns, "user", contentBlocks(request.input, "input"))
  } else {
    for (const [index, item] of request.input.entries()) {
      const at = `input[${index}]`
      switch (item.type) {
        case "function_call":
          calls.add(item.call_id)
          pushTurn(turns, "assistant", [
            {
              type: "tool_use",
              id: item.call_id,
              name: item.name,
              input: inputFromArguments(item.arguments, `${at}.arguments`),
            },
          ])
          break
        case "function_call_output":
          if (!calls.has(item.call_id)) {
            rejectField(
              `${at}.call_id`,
              "matches no `function_call` item earlier in the transcript, so it has no `tool_use` block to attach to",
            )
          }
          pushTurn(turns, "user", [
            {
              type: "tool_result",
              tool_use_id: item.call_id,
              // A tool result is plain text on the Anthropic side, as a system prompt is.
              content: blocksText(
                contentBlocks(item.output, `${at}.output`),
                `${at}.output`,
                "tool result",
              ),
            },
          ])
          break
        case "reasoning":
        case "item_reference":
          rejectStatefulItem(at, item.type)
          break
        case UNSUPPORTED:
          rejectField(`${at}.type`, `\`${item.actual}\` has no anthropic counterpart`)
          break
        default: {
          // `{role, content}` with no `type` at all is the shorthand every Responses client writes.
          const blocks = contentBlocks(item.content, `${at}.content`)
          if (item.role === "system" || item.role === "developer") {
            // Anthropic has one top-level system prompt, wherever Responses put its system items.
            const text = blocksText(blocks, `${at}.content`, "system prompt")
            if (text.length > 0) system.push(text)
          } else {
            pushTurn(turns, item.role, blocks)
          }
        }
      }
    }
  }

  const messages = mergeTurns(turns)
  if (messages.length === 0) {
    rejectField("input", "carries no user or assistant turn: an anthropic request needs one")
  }

  return {
    model: request.model,
    messages,
    max_tokens: request.max_output_tokens ?? options.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
    system: system.length === 0 ? undefined : system.join(BLOCK_JOIN),
    temperature: request.temperature ?? undefined,
    top_p: request.top_p ?? undefined,
    stream: request.stream ?? undefined,
    tools:
      request.tools === undefined
        ? undefined
        : toolsToAnthropic(toolsFromOpenAiResponses(request.tools)),
    tool_choice:
      request.tool_choice === undefined
        ? undefined
        : toolChoiceToAnthropic(toolChoiceFromOpenAiResponses(request.tool_choice)),
  }
}

/**
 * `at` is the path of the **content field itself** — `input[2].content`, or an output's
 * `input[3].output` — because Responses spells the same array under two different names and a
 * refusal that named the wrong one would send a caller looking at the wrong item.
 */
function contentBlocks(
  content: ParsedOpenAiResponsesContent | undefined,
  at: string,
): AnthropicBlock[] {
  if (content === undefined) return []
  if (typeof content === "string") {
    // Anthropic rejects an empty text block; an empty Responses content string is simply no content.
    return content.length === 0 ? [] : [{ type: "text", text: content }]
  }

  const blocks: AnthropicBlock[] = []
  for (const [index, part] of content.entries()) {
    const field = `${at}[${index}]`
    switch (part.type) {
      // Responses spells the same text apart by direction — `input_text` on a user turn,
      // `output_text` on a replayed assistant one. Anthropic has one text block for both.
      case "input_text":
      case "output_text":
        if (part.text.length > 0) blocks.push({ type: "text", text: part.text })
        break
      case "refusal":
        // The model declined out loud on an earlier turn. Dropping the sentence it declined with
        // would replay that turn as though it had said nothing at all.
        if (part.refusal.length > 0) blocks.push({ type: "text", text: part.refusal })
        break
      case "input_image": {
        const url = part.image_url
        if (url === null || url === undefined || url.length === 0) {
          rejectField(
            `${field}.image_url`,
            "is absent: an `input_image` carrying only a `file_id` names a file stored provider-side, which this router cannot resolve and will not fetch",
          )
        }
        blocks.push(imageBlockFromUrl(url, `${field}.image_url`))
        break
      }
      default:
        rejectField(`${field}.type`, `\`${part.actual}\` has no anthropic counterpart`)
    }
  }
  return blocks
}
