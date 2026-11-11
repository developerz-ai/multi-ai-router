import type { Dialect } from "@multi-ai-router/core"
import type { ResponseObservationDescriptor } from "../../providers/types"
import type { ObservationDescriptor } from "../usage/response-observer-types"
import { responseObject } from "../usage/response-usage"
import { createEventTally } from "./stream-cap"

const CHAT_DELTA_TEXT = ["content", "reasoning_content", "reasoning", "refusal"] as const

/**
 * Whether one parsed upstream frame carries words the model produced — a content, thinking, or
 * tool-argument delta. Envelope frames (`message_start`, `ping`, a role-only chat delta) do not
 * count: the Agent-SDK path synthesizes those before the model has said anything, so relayed bytes
 * alone are not proof the account served.
 */
export function isModelOutputFrame(
  dialect: Dialect,
  payload: unknown,
  event: string | undefined,
): boolean {
  const root = responseObject(payload)
  const type = root?.type ?? event
  if (dialect === "anthropic") return type === "content_block_delta"
  if (dialect === "openai-responses")
    return typeof type === "string" && type.startsWith("response.") && type.endsWith(".delta")
  const choices = root?.choices
  if (!Array.isArray(choices)) return false
  return choices.some((choice) => {
    const delta = responseObject(responseObject(choice)?.delta)
    if (delta === undefined) return false
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) return true
    return CHAT_DELTA_TEXT.some((key) => {
      const value = delta[key]
      return typeof value === "string" && value.length > 0
    })
  })
}

/**
 * Wraps a driver's observation descriptor so the observer's existing frame parse also reports model
 * output — no second pass over the stream. Absent a driver descriptor, `evidence-only` is the same
 * policy the observer applies to none.
 *
 * Content frames are parsed only until the first one proves model output, and only when no driver
 * hook reads frames itself: after that, a delta can change neither verdict, and parsing every one
 * cost ~10 ns per relayed byte (plan 101, 02.2). Usage and terminal frames are always read.
 */
export function observingModelOutput(
  dialect: Dialect,
  descriptor: ResponseObservationDescriptor | undefined,
  onOutput: () => void,
): ObservationDescriptor & { readonly eventTypes?: () => Readonly<Record<string, number>> } {
  const inspect = descriptor?.inspectPayload
  // A driver naming a stream cap also gets the event-type tally its failure line carries (12.8).
  const tally = descriptor?.streamCap === undefined ? undefined : createEventTally()
  let seen = false
  return {
    ...(tally === undefined ? {} : { eventTypes: tally.counts }),
    terminalPolicy: descriptor?.terminalPolicy ?? "evidence-only",
    get contentFrames() {
      return seen && inspect === undefined && tally === undefined ? "skip" : "inspect"
    },
    inspectPayload: (payload, event) => {
      tally?.note(payload, event)
      if (!seen && isModelOutputFrame(dialect, payload, event)) {
        seen = true
        onOutput()
      }
      return inspect === undefined ? null : inspect(payload, event)
    },
  }
}
