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

const NO_STATE =
  "names conversation state held by the provider: this router stores nothing between requests and picks an account per request, so there is no stored response to continue from"

const NO_CONVERSATION =
  "names a conversation the provider stores and prepends to this request: this router holds none, and serving the turn anyway would answer with every turn it names missing"

const NO_PROMPT =
  "names a prompt template stored inside openai-responses, whose text this router never sees: it cannot be carried onto another dialect, and the turn without it is missing the instructions the caller wrote"

const NO_BACKGROUND =
  "`true` asks the provider to queue the turn and be polled for the result by id, which needs provider-side state this router does not hold and a retrieval endpoint it does not expose"

/**
 * The stateful half of openai-responses, refused before any upstream call.
 *
 * `previous_response_id` and `store` are the dialect's whole reason for existing — a client sends
 * one turn and the *provider* remembers the rest. That contract cannot survive a hop onto an
 * account the router chose this request, on a dialect with no stored-conversation concept at all, so
 * the request is refused by name rather than served as though the missing history were empty
 * (docs/idea/06-protocol-translation.md#translation-matrix). `include` asks for extra fields on a
 * response shape the target does not produce, which fails the same way for the same reason.
 *
 * `conversation`, `prompt`, and `background` are the same class under three later names.
 * `conversation` points at turns the provider would prepend and this router cannot read;
 * `prompt` points at instruction text stored provider-side that this router never sees; and
 * `background` asks the provider to queue the turn and hand back an id to poll, which is a stored
 * response by another route. Each is refused by name for the reason all statefulness is: served
 * anyway, the model answers a question the caller did not ask and nothing in the reply says so.
 *
 * `store: false` and `background: false` are the stateless cases and pass. An absent `store` is not
 * read as its provider-side default: the caller stated nothing, and refusing a request over a field
 * it never sent would make every ordinary client unservable.
 */
export function assertStatelessResponses(request: {
  readonly previous_response_id?: string | null | undefined
  readonly store?: boolean | null | undefined
  readonly include?: readonly string[] | null | undefined
  readonly conversation?: unknown
  readonly prompt?: unknown
  readonly background?: boolean | null | undefined
}): void {
  if (typeof request.previous_response_id === "string") {
    rejectField("previous_response_id", NO_STATE)
  }
  if (request.store === true) rejectField("store", `\`true\` ${NO_STATE}`)
  if (request.include !== null && request.include !== undefined && request.include.length > 0) {
    rejectField("include", "asks for openai-responses fields another dialect does not produce")
  }
  if (request.conversation !== null && request.conversation !== undefined) {
    rejectField("conversation", NO_CONVERSATION)
  }
  if (request.prompt !== null && request.prompt !== undefined) rejectField("prompt", NO_PROMPT)
  if (request.background === true) rejectField("background", NO_BACKGROUND)
}

/**
 * A `reasoning` or `item_reference` input item — the two that are the *transcript's* half of the
 * same statefulness. A reasoning item replays an opaque handle the provider issued; an item
 * reference names a stored item by id. Neither has content this router could carry anywhere.
 *
 * @throws TranslationError — always.
 */
export function rejectStatefulItem(field: string, kind: string): never {
  rejectField(field, `is a \`${kind}\` item, which ${NO_STATE}`)
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
  "constrains the response shape, and this build translates no structured-output constraint onto another dialect"

/**
 * Structured output, under both names the two OpenAI dialects give it.
 *
 * `{"type":"text"}` is the default and the only form that survives: a JSON-Schema-constrained
 * response — and `json_object`'s weaker promise of *some* parseable JSON — is a **contract** the
 * caller will parse, and this build translates no such constraint onto another dialect. Refused by
 * name rather than dropped, because dropped it fails at the *caller's* `JSON.parse` with nothing
 * naming the cause: an OpenAI SDK `.parse()`, LangChain's `withStructuredOutput()`, Instructor, and
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

/** openai-chat's spelling: `response_format`, the same feature one dialect older. */
export function assertPlainResponseFormat(request: {
  readonly response_format?: { readonly type: string } | null | undefined
}): void {
  assertPlainFormat(request.response_format?.type, "response_format.type")
}
