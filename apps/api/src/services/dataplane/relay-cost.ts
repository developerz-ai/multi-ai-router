import type { Dialect } from "@multi-ai-router/core"
import type { CostEstimate } from "../cost"
import type { SseEvent } from "../translate"
import type { ResponseObservationFacts } from "../usage/response-observer-types"
import { responseObject } from "../usage/response-usage"

/**
 * `usage.cost` on a response the router itself writes.
 *
 * **A translated response carries it; a same-dialect one only on request.** A translated body and
 * its frames are already the router's own serialization, so one more member costs nothing. A
 * same-dialect relay is the upstream's bytes (non-negotiable 10) and reaches this module only when
 * the caller sent `x-router-usage: cost` (`relay-cost-optin.ts`). Absent is the answer otherwise,
 * and a caller reads absent as "not stated", the way it does on any provider without a cost.
 *
 * The figure is the `UsageRecord`'s own (`attemptCost`), priced on the upstream's counts rather than
 * on the translated ones, which fold cache writes into the prompt. Absent, never zero, whenever
 * those counts are not to be trusted: a stated `0` claims the call was free.
 *
 * docs/idea/06-protocol-translation.md#per-call-cost-on-the-wire.
 */

export interface UsageCostFields {
  /** USD. OpenRouter's field name and unit, which is what makes it readable by existing callers. */
  readonly cost: number
  /** The router prices from a table; nothing here was measured. */
  readonly cost_source: "estimated"
  /** `notional` is what a flat-fee call would have cost on the API: an attribution, not a spend. */
  readonly cost_basis: "metered" | "notional"
}

/** The attempt's price, read at the moment a frame needs it. */
export interface CostReport {
  /** Decides where the dialect keeps its usage. */
  readonly ingress: Dialect
  /** `whole`: the response is fully observed, so a JSON body's counts are readable. */
  fields(whole: boolean): UsageCostFields | null
}

type CountFacts = Pick<ResponseObservationFacts, "counts" | "usageInvalid" | "evidenceUnavailable">

export function usageCostFields(facts: CountFacts, estimate: CostEstimate): UsageCostFields | null {
  if (estimate.costEstimate === null || estimate.costBasis === "unknown") return null
  if (facts.usageInvalid || facts.evidenceUnavailable) return null
  const { tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens } = facts.counts
  if (tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens === 0) return null
  return {
    cost: Number(estimate.costEstimate),
    cost_source: "estimated",
    cost_basis: estimate.costBasis,
  }
}

/** Compact JSON, so `usage: null` on a content chunk never reads as a usage frame. */
const USAGE_OBJECT = '"usage":{'

function isUsageFrame(ingress: Dialect, event: SseEvent): boolean {
  if (ingress === "anthropic") return event.event === "message_delta"
  if (ingress === "openai-chat") return event.data.includes(USAGE_OBJECT)
  return event.event === "response.completed" || event.event === "response.incomplete"
}

/** Which of these events is the dialect's final usage frame, or `-1`. At most one per response. */
export function usageFrameIndex(ingress: Dialect, events: readonly SseEvent[]): number {
  return events.findIndex((event) => isUsageFrame(ingress, event))
}

function withUsage(holder: unknown, fields: UsageCostFields): Record<string, unknown> | null {
  const object = responseObject(holder)
  const usage = responseObject(object?.usage)
  // A cost the upstream stated itself (OpenRouter's, on an opted-in relay) is its own word: kept.
  return object === undefined || usage === undefined || "cost" in usage
    ? null
    : { ...object, usage: { ...usage, ...fields } }
}

function stampedData(ingress: Dialect, data: string, fields: UsageCostFields): string | null {
  const parsed: unknown = JSON.parse(data)
  if (ingress !== "openai-responses") {
    const stamped = withUsage(parsed, fields)
    return stamped === null ? null : JSON.stringify(stamped)
  }
  const root = responseObject(parsed)
  const response = withUsage(root?.response, fields)
  return response === null ? null : JSON.stringify({ ...root, response })
}

/** The frame with the cost in its usage. Reporting never breaks traffic: any fault leaves it as is. */
export function stampUsageFrame(report: CostReport, event: SseEvent): SseEvent {
  try {
    const fields = report.fields(false)
    const data = fields === null ? null : stampedData(report.ingress, event.data, fields)
    return data === null ? event : { ...event, data }
  } catch {
    return event
  }
}

/** Every dialect keeps a whole response's usage at the top of the body. */
export function stampUsageBody(report: CostReport, body: unknown): unknown {
  try {
    const fields = report.fields(true)
    return fields === null ? body : (withUsage(body, fields) ?? body)
  } catch {
    return body
  }
}
