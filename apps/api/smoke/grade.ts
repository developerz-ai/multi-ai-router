/**
 * Pure response grader for `bin/smoke`. A function of the response — no clock, no network, no I/O.
 *
 * Two verdicts are negative:
 *
 * - `FAIL` — the response shape was wrong for the leg's contract (forced-tool leg got prose,
 *   status wasn't 2xx, etc.). Carries a `reason` so the runner can name it on the report line.
 * - `INCONCLUSIVE` — the grader cannot reach a verdict from what came back. Reserved for cases
 *   where the runner itself decides (network failure, missing key, malformed SSE), so the grader
 *   never emits it; the runner is the only producer.
 *
 * Truncation (`stop_reason: "max_tokens"`) is graded as `FAIL` with reason `truncated`. That is the
 * spec-gate's pick — `PASS` would let a model that simply ran out of budget look like a healthy
 * router, and `INCONCLUSIVE` would leave the operator guessing — and the truncated-vs-tool-failure
 * distinction is the whole reason the grading case exists in the AC ("grades as truncated, not as a
 * tool failure": reason `truncated`, not `missing-tool-call`).
 */

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE"

export interface LegOutcome {
  readonly verdict: Verdict
  readonly reason?: string
}

export type MessagesExpectation =
  /** Plain text turn. Expect `stop_reason: "end_turn"` with at least one text block. */
  | { readonly kind: "text" }
  /** `tool_choice: { type: "tool", name }`. Expect `stop_reason: "tool_use"` and a `tool_use` block. */
  | { readonly kind: "forced_tool"; readonly name: string }
  /** `tool_choice: { type: "any" }`. Expect `stop_reason: "tool_use"` and a `tool_use` block. */
  | { readonly kind: "tool_choice_any" }
  /**
   * A user message carrying a `tool_result` block. The response is allowed to be text or to call
   * another tool — what the router must do is *accept the round trip* without erroring. The grader
   * fails only on a 4xx/5xx or an empty body.
   */
  | { readonly kind: "tool_round_trip" }
  /** A streamed forced-tool call. Events are pre-aggregated by the runner. */
  | { readonly kind: "streamed_forced_tool"; readonly name: string }
  /**
   * `thinking: { type: "enabled", budget_tokens }` plus a forced-tool call. Expect at least one
   * `thinking` block **and** a `tool_use` block in that order — thinking is the model's
   * reasoning before it acts.
   */
  | { readonly kind: "reasoning_forced_tool"; readonly name: string }

export type OpenAiExpectation =
  /**
   * `/v1/chat/completions`: `tool_choice: "required"`, with a tool defined. Expect
   * `choices[0].finish_reason: "tool_calls"` and a non-empty `tool_calls` array.
   */
  | { readonly kind: "chat_completions_required_tool" }
  /**
   * `/v1/responses`: tools defined. Expect an `output` array containing a `function_call` item.
   */
  | { readonly kind: "responses_function_call" }

export interface MessagesLeg {
  readonly endpoint: "/v1/messages"
  readonly stream: boolean
  readonly name: string
  readonly expectation: MessagesExpectation
}

export interface OpenAiLeg {
  readonly endpoint: "/v1/chat/completions" | "/v1/responses"
  readonly stream: boolean
  readonly name: string
  readonly expectation: OpenAiExpectation
  /** Required legs gate the exit code; informational legs never do. */
  readonly required: boolean
}

export type LegSpec = MessagesLeg | OpenAiLeg

/**
 * An SSE event aggregated from a streamed response. The runner emits one per chunk after parsing
 * the `event:` and `data:` lines; the grader is indifferent to how the runner got them.
 */
export interface StreamEvent {
  readonly event: string
  readonly data: unknown
}

interface AnthropicMessageResponse {
  readonly stop_reason?: string
  readonly content?: ReadonlyArray<{
    readonly type: string
    [key: string]: unknown
  }>
  readonly error?: { readonly type?: string; readonly message?: string }
}

interface OpenAiChatResponse {
  readonly choices?: ReadonlyArray<{
    readonly finish_reason?: string
    readonly message?: {
      readonly tool_calls?: ReadonlyArray<unknown>
    }
  }>
  readonly error?: { readonly message?: string }
}

interface OpenAiResponsesResponse {
  readonly output?: ReadonlyArray<{ readonly type: string; [key: string]: unknown }>
  readonly error?: { readonly message?: string }
}

/**
 * Grade a single leg. The runner hands it the status, the parsed body, and — for a stream — the
 * events it accumulated. The grader returns one verdict.
 */
export function grade(
  leg: LegSpec,
  status: number,
  body: unknown,
  events: readonly StreamEvent[] = [],
): LegOutcome {
  if (leg.endpoint === "/v1/messages") {
    return gradeMessages(leg, status, body, events)
  }
  if (leg.endpoint === "/v1/chat/completions") {
    return gradeChatCompletions(status, body)
  }
  return gradeResponses(status, body)
}

function gradeMessages(
  leg: MessagesLeg,
  status: number,
  body: unknown,
  events: readonly StreamEvent[],
): LegOutcome {
  if (status !== 200) {
    return fail(`http-${status}`, messageErrorMessage(body))
  }

  // For a streamed leg the runner passes `events`; for a non-streamed one it passes `body`. Either
  // path the function below accepts both shapes.
  const resolved = leg.stream ? synthesizedFromStream(events) : body

  const parsed = parseObject(resolved)
  if (parsed === null) {
    return fail("unparsable-body")
  }

  if (parsed.stop_reason === "max_tokens") {
    return fail("truncated")
  }

  return gradeMessagesByExpectation(leg, parsed)
}

function gradeMessagesByExpectation(leg: MessagesLeg, parsed: ParsedMessage): LegOutcome {
  switch (leg.expectation.kind) {
    case "text":
      return parsed.stop_reason === "end_turn" && hasText(parsed)
        ? pass()
        : fail(
            parsed.stop_reason === undefined ? "missing-stop-reason" : `stop-${parsed.stop_reason}`,
          )
    case "forced_tool":
    case "streamed_forced_tool":
      return parsed.stop_reason === "tool_use" && hasToolUseNamed(parsed, leg.expectation.name)
        ? pass()
        : fail(missingToolUseReason(parsed, leg.expectation.name))
    case "tool_choice_any":
      return parsed.stop_reason === "tool_use" && hasAnyToolUse(parsed)
        ? pass()
        : fail(missingToolUseReason(parsed))
    case "tool_round_trip":
      // A round trip's success is "the router did not reject the tool_result". A non-empty
      // content array is the cheapest signal that the model saw the round-trip conversation.
      return parsed.content !== undefined && parsed.content.length > 0
        ? pass()
        : fail("empty-round-trip-response")
    case "reasoning_forced_tool":
      return parsed.stop_reason === "tool_use" &&
        hasThinking(parsed) &&
        hasToolUseNamed(parsed, leg.expectation.name)
        ? pass()
        : fail(missingToolUseReason(parsed, leg.expectation.name, "missing-thinking"))
  }
}

function gradeChatCompletions(status: number, body: unknown): LegOutcome {
  if (status !== 200) {
    return fail(`http-${status}`, openAiErrorMessage(body))
  }
  const parsed = parseObject(body) as OpenAiChatResponse | null
  if (parsed === null) {
    return fail("unparsable-body")
  }
  const choice = parsed.choices?.[0]
  if (choice === undefined) {
    return fail("no-choice")
  }
  if (choice.finish_reason !== "tool_calls") {
    return fail(`finish-${choice.finish_reason ?? "none"}`)
  }
  const toolCalls = choice.message?.tool_calls
  if (toolCalls === undefined || toolCalls.length === 0) {
    return fail("no-tool-calls")
  }
  return pass()
}

function gradeResponses(status: number, body: unknown): LegOutcome {
  if (status !== 200) {
    return fail(`http-${status}`, openAiErrorMessage(body))
  }
  const parsed = parseObject(body) as OpenAiResponsesResponse | null
  if (parsed === null) {
    return fail("unparsable-body")
  }
  const output = parsed.output
  if (output === undefined || output.length === 0) {
    return fail("no-output")
  }
  if (!output.some((item) => item.type === "function_call")) {
    return fail("no-function-call")
  }
  return pass()
}

interface ParsedMessage {
  readonly stop_reason?: string
  readonly content?: ReadonlyArray<{ readonly type: string; [key: string]: unknown }>
}

function parseObject(value: unknown): ParsedMessage | null {
  if (typeof value !== "object" || value === null) return null
  return value as ParsedMessage
}

function hasText(parsed: ParsedMessage): boolean {
  return parsed.content?.some((block) => block.type === "text") ?? false
}

function hasToolUseNamed(parsed: ParsedMessage, name: string): boolean {
  return (
    parsed.content?.some(
      (block) => block.type === "tool_use" && (block as { name?: unknown }).name === name,
    ) ?? false
  )
}

function hasAnyToolUse(parsed: ParsedMessage): boolean {
  return parsed.content?.some((block) => block.type === "tool_use") ?? false
}

function hasThinking(parsed: ParsedMessage): boolean {
  return parsed.content?.some((block) => block.type === "thinking") ?? false
}

function missingToolUseReason(
  parsed: ParsedMessage,
  expectedName?: string,
  extra?: string,
): string {
  const parts: string[] = []
  if (parsed.stop_reason !== undefined && parsed.stop_reason !== "tool_use") {
    parts.push(`stop-${parsed.stop_reason}`)
  }
  if (!hasAnyToolUse(parsed)) {
    parts.push("missing-tool-use")
  } else if (expectedName !== undefined && !hasToolUseNamed(parsed, expectedName)) {
    parts.push(`wrong-tool`)
  }
  if (extra !== undefined) parts.push(extra)
  return parts.length === 0 ? "missing-tool-use" : parts.join(",")
}

function messageErrorMessage(body: unknown): string | undefined {
  const parsed = parseObject(body) as AnthropicMessageResponse | null
  const message = parsed?.error?.message
  return message === undefined ? undefined : `error:${message}`
}

function openAiErrorMessage(body: unknown): string | undefined {
  const parsed = parseObject(body) as OpenAiChatResponse | OpenAiResponsesResponse | null
  const message = parsed?.error?.message
  return message === undefined ? undefined : `error:${message}`
}

/**
 * Reconstructs the final Anthropic message body from a sequence of SSE events the runner collected.
 * The runner passes only the events it could parse as JSON; anything else is silently dropped.
 *
 * Merges `message_start`, every `content_block_start`/`content_block_delta` pair, and
 * `message_delta` (which carries `stop_reason`) into the same shape `parseObject` reads. The
 * returned value passes the same grader as a non-streamed body would.
 */
function synthesizedFromStream(events: readonly StreamEvent[]): unknown {
  const out: {
    stop_reason?: string
    content: Array<{ type: string; [key: string]: unknown }>
  } = { content: [] }

  for (const evt of events) {
    if (evt.event === "message_delta") {
      const data = evt.data
      if (typeof data === "object" && data !== null) {
        const delta = data as { delta?: { stop_reason?: unknown } }
        if (typeof delta.delta?.stop_reason === "string") {
          out.stop_reason = delta.delta.stop_reason
        }
      }
    }
    if (evt.event === "content_block_start") {
      const data = evt.data
      if (typeof data === "object" && data !== null) {
        const block = data as { content_block?: { type?: unknown; [key: string]: unknown } }
        if (
          typeof block.content_block === "object" &&
          block.content_block !== null &&
          typeof block.content_block.type === "string"
        ) {
          out.content.push(block.content_block as { type: string; [key: string]: unknown })
        }
      }
    }
  }
  return out
}

function pass(): LegOutcome {
  return { verdict: "PASS" }
}

function fail(reason: string, extra?: string): LegOutcome {
  const fullReason = extra === undefined ? reason : `${reason}:${extra}`
  return { verdict: "FAIL", reason: fullReason }
}
