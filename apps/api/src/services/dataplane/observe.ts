import type { Dialect, UsageOutcome } from "@multi-ai-router/core"
import { SUCCESS_OUTCOME } from "./records"
import type { DataPlaneClock, RequestSample } from "./types"

/**
 * How one dispatch becomes one `RequestSample`.
 *
 * Split out of the orchestrator because it answers a different question: the orchestrator decides
 * what to *do* with a request, this decides what to *say* about it afterwards. Keeping the two
 * apart means a change to what `/metrics` reports never edits the dispatch loop.
 *
 * Nothing here throws or awaits. An observer that could fail would turn reporting into a second
 * failure mode for a request that already succeeded.
 */

/** The parts of a request every sample of it shares, resolved before the first attempt. */
export interface SampleIdentity {
  readonly ingressDialect: Dialect
  readonly keyId: string
}

/** The mutable half of one dispatch: what the observer needs and only `serve` finds out. */
export interface RequestProgress {
  readonly startedAt: Date
  readonly requestStarted: number
  model: string | null
}

export function sampleOf(
  identity: SampleIdentity,
  progress: RequestProgress,
  outcome: UsageOutcome,
  clock: DataPlaneClock,
  isStreamed: boolean,
): RequestSample {
  return {
    ingressDialect: identity.ingressDialect,
    model: progress.model,
    keyId: identity.keyId,
    outcome,
    durationMs: Math.max(0, clock.elapsed() - progress.requestStarted),
    streamed: isStreamed,
  }
}

/**
 * A relayed upstream error is a `Response`, not a throw — the chain hands back the provider's own
 * answer when that is the honest one. Counting it as a success because it resolved would report a
 * pool answering nothing but 400s as perfectly healthy.
 */
export function outcomeForResponse(response: Response): UsageOutcome {
  if (response.ok) return SUCCESS_OUTCOME
  return response.status < 500 ? "client_error" : "upstream_error"
}

export function streamed(response: Response): boolean {
  return response.headers.get("content-type")?.includes("text/event-stream") ?? false
}
