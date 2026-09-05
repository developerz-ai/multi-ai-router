import { z } from "zod"

/**
 * The narrow, **checked** view of what a `query()` subprocess says.
 *
 * The SDK ships TypeScript types for its message union, and they are a claim rather than a check:
 * the values themselves arrive as JSON over a subprocess pipe from a binary this router does not
 * version-pin tightly. That is a provider response by every definition the house rules use, so it
 * is validated at the boundary like one — and a message that fails to parse is *skipped*, never
 * thrown on. Once bytes are on the wire a request fails honestly; before them, one unreadable frame
 * out of a hundred is not a reason to fail a turn that otherwise succeeded.
 *
 * Narrow on purpose. The SDK union has ~35 members and re-synthesis reads six of them
 * (docs/idea/11-anthropic-agent-sdk.md §6); typing the renderer against the full union would couple
 * every test to SDK internals, and typing it against `unknown` + these schemas means a test hands in
 * plain objects. `looseObject` everywhere, so a field the SDK adds tomorrow survives the parse.
 *
 * **Usage is read here rather than through `services/translate/shared/usage.ts`** for two reasons:
 * that module lives a layer above this one, and there is no conversion owed — the SDK already
 * reports Anthropic's own four-field decomposition, so the crossing this router does everywhere
 * else does not exist on this path.
 */

/** One bad field yields absence rather than discarding the whole block. */
const tokenCount = z.number().int().nonnegative().nullish().catch(null)

const usageSchema = z.looseObject({
  input_tokens: tokenCount,
  output_tokens: tokenCount,
  cache_creation_input_tokens: tokenCount,
  cache_read_input_tokens: tokenCount,
})

/**
 * The SDK message envelope, reduced to the fields §6's table branches on.
 *
 * `parent_tool_use_id` is load-bearing and easy to miss: non-null means the message came from a
 * **subagent**, a turn the client never asked for. Its content is not the answer, and forwarding it
 * would splice a second conversation into the response.
 */
const sdkMessageSchema = z.looseObject({
  type: z.string(),
  subtype: z.string().nullish(),
  parent_tool_use_id: z.string().nullish(),
  session_id: z.string().nullish(),
  /** `stream_event` only: a raw Anthropic wire event, the one payload that reaches the client. */
  event: z.unknown().optional(),
  /** `rate_limit_event` only. Account state, never forwarded (§5). */
  rate_limit_info: z.unknown().optional(),
  /** `result` only: the authoritative aggregate. An `assistant`'s covers one internal turn. */
  usage: usageSchema.nullish().catch(null),
  stop_reason: z.string().nullish(),
  /** `assistant` only: the SDK's own id for this message, which is what an undo rewinds to (§4). */
  uuid: z.string().nullish(),
  /**
   * `result` only: the turn failed, and these say how. `result` carries the API's own sentence on
   * a `success`-subtype error (the shape an auth failure arrives in); `errors` carries the list an
   * `error_during_execution` result names; the two numbers are the structured facts the SDK adds
   * beside the prose — the upstream HTTP status when the failure was an API answer, and the
   * SDK's own word for why the turn stopped (`prompt_too_long`, `api_error`, …).
   */
  is_error: z.boolean().nullish().catch(null),
  result: z.string().nullish().catch(null),
  errors: z.array(z.string()).nullish().catch(null),
  api_error_status: z.number().int().nullish().catch(null),
  terminal_reason: z.string().nullish().catch(null),
})

export interface SdkMessageView {
  readonly type: string
  readonly subtype: string | null
  /** Non-null when a subagent produced this. Such a message never reaches the client. */
  readonly parentToolUseId: string | null
  readonly sessionId: string | null
  readonly event: unknown
  readonly rateLimitInfo: unknown
  readonly usage: SdkUsage | null
  readonly stopReason: string | null
  /** The SDK message id an `assistant` message carries. Null on every other type. */
  readonly uuid: string | null
  /** `result` only: the turn ended in failure. False on every other type. */
  readonly isError: boolean
  /** What the SDK said went wrong: the `result` sentence, else the `errors` list joined. */
  readonly errorText: string
  /** The upstream HTTP status behind a failed `result`, when the SDK reported one. */
  readonly apiErrorStatus: number | null
  /** The SDK's own reason a `result` stopped, when it named one. */
  readonly terminalReason: string | null
}

export interface SdkUsage {
  readonly input_tokens: number | null
  readonly output_tokens: number | null
  readonly cache_creation_input_tokens: number | null
  readonly cache_read_input_tokens: number | null
}

/** @returns null when the value is not an SDK message at all. The caller skips it. */
export function readSdkMessage(value: unknown): SdkMessageView | null {
  const parsed = sdkMessageSchema.safeParse(value)
  if (!parsed.success) return null
  const data = parsed.data
  return {
    type: data.type,
    subtype: data.subtype ?? null,
    parentToolUseId: data.parent_tool_use_id ?? null,
    sessionId: data.session_id ?? null,
    event: data.event,
    rateLimitInfo: data.rate_limit_info,
    usage: readUsage(data.usage),
    stopReason: data.stop_reason ?? null,
    uuid: data.uuid ?? null,
    isError: data.type === "result" && data.is_error === true,
    errorText: errorTextOf(data.result, data.errors),
    apiErrorStatus: data.api_error_status ?? null,
    terminalReason: nonEmpty(data.terminal_reason),
  }
}

/**
 * The SDK's own precedence, mirrored (`Query.readMessages` in the SDK: a `success`-subtype error
 * carries its sentence in `result`, every other subtype lists its causes in `errors`), so the text
 * this router classifies is the text the SDK would have thrown had the subprocess exited non-zero.
 */
function errorTextOf(
  result: string | null | undefined,
  errors: readonly string[] | null | undefined,
): string {
  const sentence = nonEmpty(result)
  if (sentence !== null) return sentence
  return (errors ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join("; ")
}

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? null : trimmed
}

/** @returns null when the value is not a usage block — absent or malformed. Never a zeroed one. */
export function readUsage(value: unknown): SdkUsage | null {
  const parsed = usageSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    input_tokens: parsed.data.input_tokens ?? null,
    output_tokens: parsed.data.output_tokens ?? null,
    cache_creation_input_tokens: parsed.data.cache_creation_input_tokens ?? null,
    cache_read_input_tokens: parsed.data.cache_read_input_tokens ?? null,
  }
}

/**
 * A raw Anthropic wire event, as carried in `stream_event.event`.
 *
 * Only `type` and `index` are read — everything else is forwarded verbatim, because the payload
 * *is* the Anthropic dialect and re-serializing it field by field would be the one thing a router
 * this codebase is careful never to do. The index is read because it is the one field that is not
 * the SDK's to decide (`index-map.ts`).
 */
const wireEventSchema = z.looseObject({
  type: z.string(),
  index: z.number().int().nonnegative().nullish().catch(null),
})

export interface WireEvent {
  readonly type: string
  /** The SDK's own block index, restarted per internal turn. Never sent to a client as-is. */
  readonly index: number | null
  /** The whole event object, forwarded as the client's frame after the index is rewritten. */
  readonly raw: Readonly<Record<string, unknown>>
}

/** @returns null when the payload is not a wire event. Nothing is forwarded for it. */
export function readWireEvent(value: unknown): WireEvent | null {
  const parsed = wireEventSchema.safeParse(value)
  if (!parsed.success) return null
  return {
    type: parsed.data.type,
    index: parsed.data.index ?? null,
    raw: parsed.data as Readonly<Record<string, unknown>>,
  }
}

const messageFactsSchema = z.looseObject({
  message: z.looseObject({ id: z.string().nullish(), model: z.string().nullish() }).nullish(),
})

export interface MessageFacts {
  readonly id: string | null
  readonly model: string | null
}

/** The id and model a `message_start` named. Both null when it named neither. */
export function readMessageFacts(event: Readonly<Record<string, unknown>>): MessageFacts {
  const parsed = messageFactsSchema.safeParse(event)
  if (!parsed.success) return { id: null, model: null }
  return { id: parsed.data.message?.id ?? null, model: parsed.data.message?.model ?? null }
}

const stopFactsSchema = z.looseObject({
  delta: z
    .looseObject({ stop_reason: z.string().nullish(), stop_sequence: z.string().nullish() })
    .nullish(),
})

export interface StopFacts {
  readonly stopReason: string | null
  readonly stopSequence: string | null
}

/** Why a `message_delta` says the turn ended. Absence stays absence — never defaulted here. */
export function readStopFacts(event: Readonly<Record<string, unknown>>): StopFacts {
  const parsed = stopFactsSchema.safeParse(event)
  if (!parsed.success) return { stopReason: null, stopSequence: null }
  return {
    stopReason: parsed.data.delta?.stop_reason ?? null,
    stopSequence: parsed.data.delta?.stop_sequence ?? null,
  }
}
