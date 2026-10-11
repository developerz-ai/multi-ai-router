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
 * Truncation (`stop_reason: "max_tokens"`) is graded as `FAIL` with reason `truncated`. `PASS`
 * would let a model that simply ran out of budget look like a healthy router, and `INCONCLUSIVE`
 * would leave the operator guessing.
 *
 * The OpenAI-shape graders (`/v1/chat/completions`, `/v1/responses`) live in `grade-openai.ts`;
 * `grade()` is the entrypoint for every endpoint.
 */

import { gradeChatCompletions, gradeResponses } from "./grade-openai"

export { gradeChatCompletions, gradeResponses } from "./grade-openai"

export type Verdict = "PASS" | "FAIL" | "INCONCLUSIVE"

export interface LegOutcome {
  readonly verdict: Verdict
  readonly reason?: string
  /** Reported on legs whose grader knows whether a `thinking` block came back. */
  readonly thinkingPresent?: boolean
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
   * Adaptive thinking plus an effort and a forced tool. Adaptive may emit a thinking block or
   * skip straight to the tool call — the spec the Luna route returned on 2026-10-11, and the
   * Responses-translated route always returns. The grader PASSes on the tool call and reports
   * whether a thinking block came back as information.
   */
  | { readonly kind: "reasoning_forced_tool"; readonly name: string }

export type OpenAiExpectation =
  | { readonly kind: "chat_completions_required_tool" }
  | { readonly kind: "responses_function_call" }

export interface MessagesLeg {
  readonly endpoint: "/v1/messages"
  readonly stream: boolean
  readonly name: string
  readonly expectation: MessagesExpectation
  /** Required legs gate the exit code. */
  readonly required: boolean
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

export interface StreamEvent {
  readonly event: string
  readonly data: unknown
}

interface AnthropicMessageResponse {
  readonly stop_reason?: string
  readonly content?: ReadonlyArray<{ readonly type: string; [key: string]: unknown }>
  readonly error?: { readonly type?: string; readonly message?: string }
}

export function grade(
  leg: LegSpec,
  status: number,
  body: unknown,
  events: readonly StreamEvent[] = [],
): LegOutcome {
  if (leg.endpoint === "/v1/messages") return gradeMessages(leg, status, body, events)
  if (leg.endpoint === "/v1/chat/completions") return gradeChatCompletions(status, body)
  return gradeResponses(status, body)
}

interface ParsedMessage {
  readonly stop_reason?: unknown
  readonly content?: unknown
}

export function parseObject(value: unknown): ParsedMessage | null {
  if (typeof value !== "object" || value === null) return null
  return value as ParsedMessage
}

function asContent(parsed: ParsedMessage): ReadonlyArray<{ readonly type: string }> | undefined {
  // A malformed `content` (string, null, `[null]`, missing) is FAIL `malformed-body`, not a
  // throw that escapes the runner. We guard the array AND every element so `[null]` returns
  // undefined — the grader then reports FAIL with reason `malformed-body`.
  const raw = parsed.content
  if (!Array.isArray(raw)) return undefined
  const blocks: Array<{ readonly type: string }> = []
  for (const block of raw) {
    if (block === null || typeof block !== "object" || typeof block.type !== "string") {
      return undefined
    }
    blocks.push(block as { readonly type: string })
  }
  return blocks
}

function gradeMessages(
  leg: MessagesLeg,
  status: number,
  body: unknown,
  events: readonly StreamEvent[],
): LegOutcome {
  if (status !== 200) return fail(`http-${status}`, messageErrorMessage(body))

  // For a streamed leg the runner passes `events`; for a non-streamed one it passes `body`. The
  // synthesizer produces the same shape `asContent` reads.
  const resolved = leg.stream ? synthesizedFromStream(events) : body
  const parsed = parseObject(resolved)
  if (parsed === null) return fail("unparsable-body")
  const content = asContent(parsed)
  if (content === undefined) return fail("malformed-body")
  if (parsed.stop_reason === "max_tokens") return fail("truncated")

  const view: MessageView = { stopReason: parsed.stop_reason, content }
  return gradeMessagesByExpectation(leg, view)
}

interface MessageView {
  readonly stopReason?: unknown
  readonly content: ReadonlyArray<{ readonly type: string }>
}

function gradeMessagesByExpectation(leg: MessagesLeg, view: MessageView): LegOutcome {
  switch (leg.expectation.kind) {
    case "text":
      return view.stopReason === "end_turn" && hasText(view)
        ? pass()
        : fail(view.stopReason === undefined ? "missing-stop-reason" : `stop-${view.stopReason}`)
    case "forced_tool":
    case "streamed_forced_tool":
      return view.stopReason === "tool_use" && hasToolUseNamed(view, leg.expectation.name)
        ? pass()
        : fail(missingToolUseReason(view, leg.expectation.name))
    case "tool_choice_any":
      return view.stopReason === "tool_use" && hasAnyToolUse(view)
        ? pass()
        : fail(missingToolUseReason(view))
    case "tool_round_trip":
      return view.content.length > 0 ? pass() : fail("empty-round-trip-response")
    case "reasoning_forced_tool":
      return view.stopReason === "tool_use" && hasToolUseNamed(view, leg.expectation.name)
        ? withThinking(pass(), view)
        : fail(missingToolUseReason(view, leg.expectation.name))
  }
}

function hasText(view: MessageView): boolean {
  return view.content.some((block) => block.type === "text")
}

function hasToolUseNamed(view: MessageView, name: string): boolean {
  return view.content.some(
    (block) => block.type === "tool_use" && (block as { name?: unknown }).name === name,
  )
}

function hasAnyToolUse(view: MessageView): boolean {
  return view.content.some((block) => block.type === "tool_use")
}

function hasThinking(view: MessageView): boolean {
  return view.content.some((block) => block.type === "thinking")
}

function missingToolUseReason(view: MessageView, expectedName?: string): string {
  const parts: string[] = []
  if (view.stopReason !== undefined && view.stopReason !== "tool_use") {
    parts.push(`stop-${view.stopReason}`)
  }
  if (!hasAnyToolUse(view)) {
    parts.push("missing-tool-use")
  } else if (expectedName !== undefined && !hasToolUseNamed(view, expectedName)) {
    parts.push("wrong-tool")
  }
  return parts.length === 0 ? "missing-tool-use" : parts.join(",")
}

function withThinking(outcome: LegOutcome, view: MessageView): LegOutcome {
  return { ...outcome, thinkingPresent: hasThinking(view) }
}

function messageErrorMessage(body: unknown): string | undefined {
  const parsed = parseObject(body) as AnthropicMessageResponse | null
  const message = parsed?.error?.message
  return message === undefined ? undefined : `error:${message}`
}

/** Reconstructs the final Anthropic message body from SSE events: `message_delta.stop_reason`
 * plus every `content_block_start`'s `content_block`. */
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
        if (typeof delta.delta?.stop_reason === "string") out.stop_reason = delta.delta.stop_reason
      }
    }
    if (evt.event === "content_block_start") {
      const data = evt.data
      if (typeof data === "object" && data !== null) {
        const block = data as { content_block?: { type?: unknown; [key: string]: unknown } }
        const cb = block.content_block
        if (typeof cb === "object" && cb !== null && typeof cb.type === "string") {
          out.content.push(cb as { type: string; [key: string]: unknown })
        }
      }
    }
  }
  return out
}

export function pass(): LegOutcome {
  return { verdict: "PASS" }
}

export function fail(reason: string, extra?: string): LegOutcome {
  const fullReason = extra === undefined ? reason : `${reason}:${extra}`
  return { verdict: "FAIL", reason: fullReason }
}
