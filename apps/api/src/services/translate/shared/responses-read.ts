import { z } from "zod"
import type { OpenAiResponsesUsage } from "./usage"
import { parseOpenAiResponsesUsage } from "./usage"

/**
 * Reading an openai-responses answer — the body and the stream events — for every dialect it has to
 * be translated into.
 *
 * A Responses body states an ordered `output` array of *items* where both other dialects state one
 * message: a `message` item holding `output_text` parts, a `function_call` item, a `reasoning` item
 * summarizing what the model thought. Flattening that array is the same work whichever target is
 * being aimed at, so it happens once here and each translator only decides what to build from it.
 *
 * **Nothing here throws.** The upstream already answered, so a field this module cannot read is
 * reported as absent rather than turned into a failure on a request that cannot be retried
 * (docs/idea/06-protocol-translation.md, "Rejected: nothing at stream time").
 */

const partSchema = z.looseObject({
  type: z.string().nullish().catch(null),
  text: z.string().nullish().catch(null),
  refusal: z.string().nullish().catch(null),
})

const itemSchema = z.looseObject({
  type: z.string().nullish().catch(null),
  id: z.string().nullish().catch(null),
  call_id: z.string().nullish().catch(null),
  name: z.string().nullish().catch(null),
  arguments: z.string().nullish().catch(null),
  content: z.array(partSchema).nullish().catch(null),
  summary: z.array(partSchema).nullish().catch(null),
})

const responseSchema = z.looseObject({
  id: z.string().nullish().catch(null),
  model: z.string().nullish().catch(null),
  status: z.string().nullish().catch(null),
  incomplete_details: z
    .looseObject({ reason: z.string().nullish().catch(null) })
    .nullish()
    .catch(null),
  output: z.array(itemSchema).nullish().catch(null),
  usage: z.unknown().optional(),
  error: z.unknown().optional(),
})

/**
 * One Responses stream event, read permissively.
 *
 * Every field any of the events in the spec's table carries is optional here, because the event
 * *type* is what selects which of them are meaningful and a translator switches on it. Anything
 * this build does not name — the `.done` mirrors of deltas it already forwarded, the annotation
 * events — parses fine and produces nothing.
 */
export const responsesEventSchema = z.looseObject({
  type: z.string().nullish().catch(null),
  response: responseSchema.nullish().catch(null),
  item: itemSchema.nullish().catch(null),
  item_id: z.string().nullish().catch(null),
  output_index: z.number().int().nullish().catch(null),
  delta: z.string().nullish().catch(null),
  arguments: z.string().nullish().catch(null),
  code: z.string().nullish().catch(null),
  message: z.string().nullish().catch(null),
})

export type ParsedResponsesEvent = z.infer<typeof responsesEventSchema>
export type ParsedResponsesItem = z.infer<typeof itemSchema>

export interface ReadTextItem {
  readonly kind: "text"
  readonly text: string
}

export interface ReadCallItem {
  readonly kind: "function_call"
  readonly callId: string
  readonly name: string
  readonly arguments: string
}

export interface ReadReasoningItem {
  readonly kind: "reasoning"
  readonly summary: string
}

export type ReadResponsesItem = ReadTextItem | ReadCallItem | ReadReasoningItem

export interface ReadResponsesBody {
  readonly id: string | null
  readonly model: string | null
  readonly status: string | null
  readonly incompleteReason: string | null
  readonly items: readonly ReadResponsesItem[]
  readonly usage: OpenAiResponsesUsage | null
}

const TEXT_JOIN = "\n"

/** @returns every field absent when the body is not a Responses object at all. */
export function readResponsesBody(body: unknown): ReadResponsesBody {
  const parsed = responseSchema.safeParse(body)
  const response = parsed.success ? parsed.data : null

  const items: ReadResponsesItem[] = []
  for (const item of response?.output ?? []) {
    const read = readResponsesItem(item)
    if (read !== null) items.push(read)
  }

  return {
    id: response?.id ?? null,
    model: response?.model ?? null,
    status: response?.status ?? null,
    incompleteReason: response?.incomplete_details?.reason ?? null,
    items,
    usage: parseOpenAiResponsesUsage(response?.usage),
  }
}

/**
 * One output item, flattened.
 *
 * A `refusal` part is carried as text: the model declined out loud, and dropping the sentence it
 * declined with would answer as though it had said nothing. An item type this build does not know
 * yields null — a built-in tool call served inside Responses has no counterpart anywhere else, and
 * inventing text for it would put the router's words in the model's mouth.
 */
export function readResponsesItem(item: ParsedResponsesItem): ReadResponsesItem | null {
  const type = item.type ?? "message"
  if (type === "message") {
    const text = partsText(item.content)
    return text.length === 0 ? null : { kind: "text", text }
  }
  if (type === "function_call") {
    return {
      kind: "function_call",
      callId: item.call_id ?? item.id ?? "",
      name: item.name ?? "",
      arguments: item.arguments ?? "",
    }
  }
  if (type === "reasoning") {
    const summary = partsText(item.summary)
    return summary.length === 0 ? null : { kind: "reasoning", summary }
  }
  return null
}

function partsText(parts: readonly z.infer<typeof partSchema>[] | null | undefined): string {
  const texts: string[] = []
  for (const part of parts ?? []) {
    const text = part.text ?? part.refusal ?? ""
    if (text.length > 0) texts.push(text)
  }
  return texts.join(TEXT_JOIN)
}
