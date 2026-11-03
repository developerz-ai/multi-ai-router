/**
 * The router's own token-count estimate, for the one scope a provider cannot count for us.
 *
 * A Claude subscription reaches the router through the Agent SDK, and the SDK is a completion
 * transport: it states no token-count call, and the one thing this router will never do to reach
 * an endpoint it lacks is forge an `api.anthropic.com` request out of a subscription's credentials
 * (docs/idea/11-anthropic-agent-sdk.md). So a scope holding nothing but subscriptions has no
 * provider to ask.
 *
 * What it has instead is the request body, already in memory, and a client that needs a number to
 * decide when to compact its context. So the router answers with an **estimate**, and — this is the
 * whole point — says so in the body:
 *
 *     { "input_tokens": 1234, "estimated": true, "estimate_basis": "chars-per-token-v1" }
 *
 * `input_tokens` keeps Anthropic's name so an unmodified client reads it as the threshold it
 * expects; `estimated` is what makes the difference from a measurement visible to anything that
 * looks. The three fields always travel together — an estimate that answered with `input_tokens`
 * alone would be indistinguishable from a provider's number, which is the one thing this must not
 * be.
 *
 * The number itself is a **documented approximation**: this router ships no Claude tokenizer, so
 * the count is derived from the body's decoded prompt content rather than from the provider's own
 * vocabulary. It is rounded **up**, because the direction of the error matters — a client that
 * compacts slightly early loses a little context, and a client that compacts late blows its
 * window.
 *
 * **Two regions of a body are not prose, and are counted as what they are: serialized JSON.** A
 * tool call's `input` and a tool's `input_schema` reach the model as JSON — the subscription path
 * renders a tool call as `[the assistant called plot with {"…"}]` — so every brace, comma and
 * quote of them is text the model reads, and they count whole. An estimate that counted only
 * their keys and leaves missed the structure, and the structure is where a growth hides: a tool
 * input holding a hundred thousand empty objects is three hundred kilobytes of prompt, and it
 * measured the same as an empty one — so a client compacting on that number never compacted.
 *
 * The estimate itself is pure: no clock, no I/O, no network, no store. The same bytes always
 * produce the same number.
 */

import { attemptRecord } from "./records"
import type { DispatchRuntime } from "./runtime"

/**
 * Characters per token, for the estimate.
 *
 * A named constant and not a literal buried in an expression: the divisor is the whole claim this
 * module makes, so it has to be one value a reader can find, change, and argue with — not a `4`
 * that appears once and is never seen again.
 */
export const ESTIMATE_CHARS_PER_TOKEN = 4

/**
 * Machine-readable label for how the number was produced. Short, stable, and part of the wire
 * shape: a client that wants to know whether it is reading a measurement can compare it.
 */
export const ESTIMATE_BASIS = "chars-per-token-v1"

/**
 * Anthropic's `count_tokens` answer, plus the label that says this one is the router's own.
 *
 * `input_tokens` is the provider's own field name on purpose — Claude Code reads it as a
 * compaction threshold and does not care where the number came from, and this shape lets it work
 * unmodified. `estimated` and `estimate_basis` are the router's additions, and they are what make
 * the answer honest.
 */
export interface CountTokensEstimateBody {
  readonly input_tokens: number
  /** Always true here. Its presence is what distinguishes this from a provider's measurement. */
  readonly estimated: true
  readonly estimate_basis: string
}

/** The estimate itself: a token count and the basis it was derived on. */
export interface CountEstimate {
  readonly inputTokens: number
  readonly basis: string
}

/** A decoded JSON document, as `JSON.parse` produces it and as this module walks it. */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** One value on the walk, and whether the model reads it as serialized JSON. */
interface WalkItem {
  readonly value: JsonValue
  readonly serialized: boolean
}

/** Characters of a string, counted the way a tokenizer meets them: one code point each. */
function codePoints(text: string): number {
  let count = 0
  const characters = text[Symbol.iterator]()
  for (let step = characters.next(); !step.done; step = characters.next()) {
    count += 1
  }
  return count
}

/**
 * The request's **envelope**: top-level fields that configure the call rather than carry context.
 *
 * The model name, the sampling knobs, the stream flag, the response ceiling, the metadata — a
 * tokenizer meets none of them; they are the shape of the request, not its content. The envelope
 * is excluded whole, key and value alike, and the exclusion is a fact about the **top level
 * only**: inside `messages`, `system` and `tools` every field is prompt.
 */
const ENVELOPE_FIELDS: ReadonlySet<string> = new Set([
  "model",
  "max_tokens",
  "metadata",
  "stop_sequences",
  "stream",
  "temperature",
  "thinking",
  "tool_choice",
  "top_k",
  "top_p",
  "service_tier",
])

/**
 * Count the characters of the serialized prompt content in a decoded JSON document.
 *
 * The content counts as the text a tokenizer meets. Every **string value** is prompt — message
 * text, system blocks, tool names and descriptions — and the punctuation inside it is text the
 * model reads, not structure. But a conversation is made of more than strings: within the
 * content the object keys count, and so do the primitive leaves — a number, a boolean, a null —
 * each as the text serializing it produces. History that grows by a hundred thousand numbers is
 * a conversation that grew, and the estimate has to move when it does.
 *
 * **The two JSON regions count whole, delimiters included.** A tool call's `input` and a tool's
 * `input_schema` are not prose: they reach the model as serialized JSON, so their braces,
 * commas, colons and quotes are text the model reads, and they are counted as the serialized form
 * they are. Counting their keys and leaves alone dropped the structure — and the structure is
 * where a growth hides: a tool input holding a hundred thousand empty objects is three hundred
 * kilobytes of prompt, and it measured the same as an empty one.
 *
 * Only the request envelope is excluded (`ENVELOPE_FIELDS`), at the top level only. A top-level
 * field the set does not name is content, not envelope: an uncounted unknown is an
 * under-estimate, and under is the one direction a compaction threshold cannot afford. Outside
 * those two regions, the punctuation around the counted pieces is the one structure a tokenizer
 * never sees, and contributes nothing.
 *
 * The walk is iterative, not recursive: a request body is client-shaped, and an estimate that
 * overflowed the call stack on a deeply nested body would turn a pure count into a 500.
 */
function contentCharacters(document: JsonValue): number {
  let total = 0
  const pending: WalkItem[] = []

  if (typeof document === "object" && document !== null && !Array.isArray(document)) {
    // The body's top level: envelope fields are excluded whole, everything beside them is prompt.
    for (const [key, value] of Object.entries(document)) {
      if (ENVELOPE_FIELDS.has(key)) continue
      total += codePoints(key)
      pending.push({ value, serialized: isSerializedRegion(key, false) })
    }
  } else {
    // No envelope to strip — a body that is not an object is content whole.
    pending.push({ value: document, serialized: false })
  }

  let current = pending.pop()
  while (current !== undefined) {
    const { value, serialized } = current
    if (serialized) {
      // A region the model reads as JSON: it counts whole, delimiters included.
      total += serializedLength(value)
    } else if (typeof value === "string") {
      total += codePoints(value)
    } else if (typeof value === "number" || typeof value === "boolean") {
      // As serializing it writes the value, which is how the model meets it.
      total += String(value).length
    } else if (value === null) {
      total += "null".length
    } else if (Array.isArray(value)) {
      for (const item of value) pending.push({ value: item, serialized: false })
    } else {
      const members = Object.entries(value)
      const toolCall = members.some(([key, member]) => key === "type" && member === "tool_use")
      for (const [key, member] of members) {
        total += codePoints(key)
        pending.push({ value: member, serialized: isSerializedRegion(key, toolCall) })
      }
    }
    current = pending.pop()
  }
  return total
}

/**
 * Whether the member holds JSON that reaches the model as JSON.
 *
 * Two members, and the wire names both: a tool's `input_schema` is the schema the model is
 * offered, and a tool call's `input` is the arguments the model wrote. The subscription path
 * renders the second one into the prompt verbatim — `[the assistant called plot with {"…"}]`
 * (`providers/claude-sdk/prompt-text.ts`) — so its delimiters are text the model reads.
 *
 * @param key the member's name. @param toolCall whether the object holding it is a `tool_use`
 * block, which is what makes an `input` a tool call's arguments rather than anything else.
 */
function isSerializedRegion(key: string, toolCall: boolean): boolean {
  if (key === "input_schema") return true
  return toolCall && key === "input"
}

/**
 * The length of a JSON value **as serialized** — the form `JSON.stringify` writes for it.
 *
 * Counted in code points, like the rest of this module, and computed by walking rather than by
 * calling `JSON.stringify`: that call recurses, and a client-shaped input nested fifty thousand
 * deep would overflow the stack and turn a count into a 500.
 */
function serializedLength(value: JsonValue): number {
  let total = 0
  const pending: JsonValue[] = [value]

  let current = pending.pop()
  while (current !== undefined) {
    if (typeof current === "string") {
      total += jsonStringLength(current)
    } else if (typeof current === "number") {
      total += String(current).length
    } else if (typeof current === "boolean") {
      total += current ? "true".length : "false".length
    } else if (current === null) {
      total += "null".length
    } else if (Array.isArray(current)) {
      // The brackets, and the comma between each pair of elements.
      total += 2 + Math.max(0, current.length - 1)
      for (const item of current) pending.push(item)
    } else {
      const members = Object.entries(current)
      // The braces, and the comma between each pair of members.
      total += 2 + Math.max(0, members.length - 1)
      for (const [key, member] of members) {
        // The quoted key, and the colon that follows it.
        total += jsonStringLength(key) + 1
        pending.push(member)
      }
    }
    current = pending.pop()
  }
  return total
}

/** The control characters JSON writes as a two-character escape rather than as a `\\uXXXX`. */
const SHORT_ESCAPES = new Set(["\b", "\f", "\n", "\r", "\t"])

/**
 * The length of a JSON string **as serialized**: the quotes around it, and the escapes inside.
 *
 * `JSON.stringify` escapes the quote, the backslash, the control characters and a lone surrogate;
 * every other character — including every non-ASCII one — is written as it stands.
 */
function jsonStringLength(text: string): number {
  let length = 2 // the quotes
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if (character === '"' || character === "\\") {
      length += 2
    } else if (code < 0x20) {
      length += SHORT_ESCAPES.has(character) ? 2 : 6
    } else if (code >= 0xd800 && code <= 0xdfff) {
      // A lone surrogate, which JSON writes as `\\uXXXX`.
      length += 6
    } else {
      length += 1
    }
  }
  return length
}

/**
 * Characters of the prompt content in a request body.
 *
 * The body is parsed and counted **decoded**, so a quote that travelled as `\"` counts once, and
 * the punctuation inside a prompt counts, because a tokenizer reads it. A
 * body the parser refuses (the validators should have rejected it long before an estimate) has no
 * content/envelope distinction left to make: the raw text counts whole, rather than the estimate
 * pretending it saw a prompt it did not.
 */
function promptCharacters(text: string): number {
  try {
    return contentCharacters(JSON.parse(text) as JsonValue)
  } catch {
    return codePoints(text)
  }
}

/**
 * The estimate for one request body.
 *
 * Rounded **up**: an over-estimate is the safe direction for a compaction threshold (compact
 * earlier rather than blow the context window), and it is the direction the count is deliberately
 * biased towards everywhere else in this router.
 */
export function estimateTokenCount(body: Uint8Array): CountEstimate {
  const text = new TextDecoder().decode(body)
  const characters = promptCharacters(text)
  const tokens = Math.ceil(characters / ESTIMATE_CHARS_PER_TOKEN)
  return { inputTokens: tokens, basis: ESTIMATE_BASIS }
}

/**
 * The labelled body the client receives.
 *
 * The three fields are emitted together, always. An `input_tokens` without `estimated` would be a
 * fabricated measurement wearing a provider's field name, which is the failure this whole path
 * exists to avoid.
 */
export function countTokensEstimateBody(estimate: CountEstimate): CountTokensEstimateBody {
  return {
    input_tokens: estimate.inputTokens,
    estimated: true,
    estimate_basis: estimate.basis,
  }
}

/**
 * Answer a `count_tokens` request the router had to answer for itself.
 *
 * The scope held nothing but Claude subscriptions, so no provider could be asked: the Agent SDK
 * states no token-count call, and the router will never forge an `api.anthropic.com` request out
 * of a subscription's credentials to get one. The answer comes from the body the router already
 * holds — no upstream addressed, no subprocess spawned, no account touched.
 *
 * It writes **one** usage row, and it is a success rather than a routing failure: no error class,
 * no account, no provider, and no egress mode, because none of those exist on this path. Its token
 * columns are zero and it is never priced, for the same reason the provider's own count is not
 * priced — a count measures a prompt nobody ran.
 */
export function countTokensEstimateResponse(
  body: Uint8Array,
  runtime: DispatchRuntime,
  startedAt: Date,
  requestStarted: number,
): Response {
  const estimate = estimateTokenCount(body)
  const event = attemptRecord({
    ...runtime.preflightAttribution(),
    // A count is never priced: zeroed counts against a priced model come back as
    // `metered $0.000000`, which reads as a free completion rather than as no completion.
    priced: false,
    timing: runtime.timing(startedAt, requestStarted, 0),
    outcome: "success",
    streamed: false,
    httpStatus: 200,
    responseStatus: 200,
    errorClass: null,
  })
  ;(runtime.recordTerminal ?? runtime.record)(event)
  return Response.json(countTokensEstimateBody(estimate))
}
