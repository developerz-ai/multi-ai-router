import { TranslationError } from "@multi-ai-router/core"
import type { z } from "zod"

/**
 * Every refusal a request translator can make, in one place.
 *
 * "Fail loud, never degrade" (docs/idea/06-protocol-translation.md#design-rules): a request whose
 * *contract* cannot be carried into the target dialect returns a `400` naming the offending field,
 * before any upstream call. Silently dropping a contract field is a bug; dropping a documented
 * *hint* is not, and the lossy-edge table is the authority on which is which.
 *
 * No message here ever interpolates a value out of the body — a rejected request may carry
 * anything, and an error body is one of the surfaces credential material must never reach
 * (docs/idea/07-security.md). Field names, tool names, and block type names are structural and are
 * the only thing quoted back.
 */

/** @throws TranslationError — always. `never` so callers narrow on the call. */
export function rejectField(field: string, reason: string): never {
  throw new TranslationError(`\`${field}\` ${reason}`)
}

/**
 * Parse a body into the dialect's shape, or refuse with the path that failed.
 *
 * The one place a translated request body is materialized. `06-protocol-translation.md` allows it
 * exactly here: a cross-dialect conversion has to rebuild the body field by field, so the parse is
 * genuinely required rather than speculative.
 *
 * @throws TranslationError when the body does not match `schema`.
 */
export function parseRequest<S extends z.ZodType>(
  schema: S,
  body: unknown,
  dialect: string,
): z.infer<S> {
  const parsed = schema.safeParse(body)
  if (parsed.success) return parsed.data

  const located = locate(parsed.error.issues, [])
  if (located === undefined) throw new TranslationError(`not a valid ${dialect} request`)
  const path = located.path.length === 0 ? "body" : located.path.join(".")
  throw new TranslationError(`not a valid ${dialect} request: \`${path}\` — ${located.message}`)
}

type Issue = z.ZodError["issues"][number]

interface Located {
  readonly path: readonly PropertyKey[]
  readonly message: string
}

/**
 * The deepest field a failure points at.
 *
 * A union reports at its **own** path — `messages.0.content` — while the answer a caller can act on
 * is inside one of its branches, `messages.0.content.0`. Naming the offending field is the entire
 * contract of a translation `400`, so every branch is walked and the longest path wins.
 */
function locate(issues: readonly Issue[], prefix: readonly PropertyKey[]): Located | undefined {
  let best: Located | undefined
  for (const issue of issues) {
    const path = [...prefix, ...issue.path]
    best = deeper(best, { path, message: issue.message })
    if (issue.code !== "invalid_union") continue
    for (const branch of issue.errors) best = deeper(best, locate(branch, path))
  }
  return best
}

function deeper(current: Located | undefined, candidate: Located | undefined): Located | undefined {
  if (candidate === undefined) return current
  if (current === undefined) return candidate
  return candidate.path.length > current.path.length ? candidate : current
}

const NO_COUNTERPART = "has no anthropic counterpart; it is refused rather than silently ignored"

/**
 * The three OpenAI fields that cannot reach Anthropic at all.
 *
 * They are refused rather than dropped because each is a *contract*: a caller that asked for
 * `logprobs` and got a body without them was answered a different question than the one it asked.
 * `n > 1` is the same in a louder way — a caller expecting four completions cannot use one.
 * `n: 1` is the default and passes, since asking for one completion is what Anthropic already does.
 */
export function assertTranslatableToAnthropic(request: {
  readonly n?: number | null | undefined
  readonly logprobs?: boolean | null | undefined
  readonly top_logprobs?: number | null | undefined
}): void {
  if (request.logprobs === true) rejectField("logprobs", NO_COUNTERPART)
  if (typeof request.top_logprobs === "number") rejectField("top_logprobs", NO_COUNTERPART)
  if (typeof request.n === "number" && request.n > 1) {
    rejectField("n", "> 1 has no anthropic counterpart: one request yields exactly one completion")
  }
}

/**
 * openai-chat's legacy `functions` / `function_call` are a contract like `tools`, and no other
 * dialect states them; the caller resends them as `tools` / `tool_choice`, which every hop carries.
 */
export function assertNoLegacyFunctions(request: {
  readonly functions?: unknown
  readonly function_call?: unknown
}): void {
  const legacy =
    "is the legacy spelling of function calling, which this router does not translate; send `tools` / `tool_choice` instead"
  if (request.functions !== undefined && request.functions !== null)
    rejectField("functions", legacy)
  if (request.function_call !== undefined && request.function_call !== null) {
    rejectField("function_call", legacy)
  }
}

const NO_STOP =
  "has no openai-responses counterpart at all: the dialect states no stop parameter, and a stop sequence decides where the answer ends, so dropping it would return text past the delimiter the caller drew"

/**
 * A stop sequence aimed at openai-responses, which has no stop parameter of any kind.
 *
 * Refused rather than dropped, which is the one place this build treats a *sampling* field as a
 * contract: every other knob nudges how the model writes, while a stop sequence decides where the
 * answer ends, and a caller that drew a delimiter is going to parse on it. One helper for both
 * source dialects — Anthropic's `stop_sequences` and openai-chat's `stop` are the same field with
 * two names, and two copies of the rule could disagree about which requests are servable.
 *
 * `[]` and `""` state no sequence and pass: refusing a request over a constraint it never placed
 * would make an ordinary client unservable, the same call `assertStatelessResponses` makes about an
 * absent `store`.
 */
export function assertNoStopSequence(
  stop: string | readonly string[] | null | undefined,
  field: string,
): void {
  if (stop === null || stop === undefined) return
  const stated = typeof stop === "string" ? stop.length > 0 : stop.some((one) => one.length > 0)
  if (stated) rejectField(field, NO_STOP)
}

const NO_STRUCTURED_OUTPUT =
  "constrains the response shape, which this build carries only from openai-chat onto openai-responses and anthropic; on this hop it is refused rather than dropped"

/**
 * Structured output, under both names the two OpenAI dialects give it, on every hop that cannot
 * carry it.
 *
 * `{"type":"text"}` is the default and passes everywhere. A JSON-Schema-constrained response — and
 * `json_object`'s weaker promise of *some* parseable JSON — is a **contract** the caller will parse.
 * Two hops carry it, both from openai-chat: onto openai-responses, where `response_format` becomes
 * `text.format` (`shared/structured-output.ts`), and onto anthropic, as a forced tool call
 * (`shared/structured-output-anthropic.ts`). Every other crossing still refuses it by name rather
 * than dropping it, because dropped it fails at the *caller's* `JSON.parse` with nothing naming the
 * cause: an OpenAI SDK `.parse()`, LangChain's `withStructuredOutput()`, Instructor, and
 * `generateObject` all hand back prose and a parse error instead of the `400` they can act on.
 *
 * One rule behind both spellings for the reason `assertNoStopSequence` states: two copies could
 * disagree about which requests are servable.
 */
function assertPlainFormat(type: string | undefined, field: string): void {
  if (type !== undefined && type !== "text") {
    rejectField(field, `\`${type}\` ${NO_STRUCTURED_OUTPUT}`)
  }
}

/** openai-responses' spelling: `text.format`. */
export function assertPlainTextFormat(request: {
  readonly text?: { readonly format?: { readonly type: string } | null | undefined } | null
}): void {
  assertPlainFormat(request.text?.format?.type, "text.format.type")
}

const NO_ANTHROPIC_STRUCTURED_OUTPUT =
  "constrains the response shape, and this build carries a structured-output constraint in one direction only: from openai-chat, onto openai-responses as `text.format` or onto anthropic as a forced tool call. Nothing carries it out of anthropic, so on this hop it is refused rather than dropped"

/**
 * Anthropic's own structured-output constraint, refused on every hop that cannot carry it.
 *
 * Two spellings, one feature. `output_config.format` is the field Anthropic's Messages API states
 * on the wire (`{type: "json_schema", schema: {...}}`); `output_format` is the name Anthropic's own
 * SDKs take it under (`messages.parse(output_format=…)`, which they send as `output_config.format`).
 * A client stating either is stating the same contract, so both are refused — each named as the
 * caller wrote it, because that is the field the caller has to change.
 *
 * The third spelling of one feature, counting `response_format` (openai-chat) and `text.format`
 * (openai-responses): one rule behind all of them is the reason this lives beside its siblings
 * rather than in a translator — two copies could disagree about which requests are servable.
 *
 * Dropped, it fails at the *caller's* `JSON.parse` with nothing naming the cause: the upstream
 * answered in prose, because the constraint never reached it. Refused, the caller gets a `400`
 * naming the field it has to change.
 *
 * Absent and `null` state nothing and pass — a caller that never asked for a constrained answer
 * must not be refused over it. `output_config` without a `format` is the reasoning dial, which is
 * carried, not refused.
 */
export function assertNoAnthropicStructuredOutput(request: {
  readonly output_format?: unknown
  readonly output_config?: { readonly format?: unknown } | null | undefined
}): void {
  if (request.output_format !== null && request.output_format !== undefined) {
    rejectField("output_format", NO_ANTHROPIC_STRUCTURED_OUTPUT)
  }
  const format = request.output_config?.format
  if (format !== null && format !== undefined) {
    rejectField("output_config.format", NO_ANTHROPIC_STRUCTURED_OUTPUT)
  }
}
