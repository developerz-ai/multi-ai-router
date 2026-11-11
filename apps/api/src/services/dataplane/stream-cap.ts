import type { ResponseObservationDescriptor } from "../../providers/types"
import { TranslationStreamError } from "../translate/shared/stream-error"
import type { ResponseObserver } from "../usage/response-observer-types"
import { RouterShutdownError } from "./active-requests"
import { ClientCancelledError } from "./relay-cancellation"

/**
 * Default for `UPSTREAM_STREAM_CAP_MIN_SECONDS`: an upstream-dropped stream this old or older, that
 * never completed, is taken as the provider's own stream cap. Codex's sits at ~900 s; 840 leaves a
 * minute of margin for clock skew between the two ends.
 */
export const DEFAULT_STREAM_CAP_MIN_MS = 840_000

/** Distinct event types one tally keeps; the rest count under `other`. */
const MAX_EVENT_TYPES = 24
const EVENT_TYPE = /^[a-z0-9_.]{1,64}$/

/**
 * Counts the Responses event types one stream carried — names only, never content — so a stream
 * the upstream drops can say what it was doing: reasoning deltas, or nothing but `in_progress`.
 * Bounded in distinct names and in name shape, so an upstream cannot grow a log line.
 */
export function createEventTally() {
  const counts = new Map<string, number>()
  return {
    note(payload: unknown, event: string | undefined): void {
      const named =
        event ??
        (typeof payload === "object" && payload !== null && "type" in payload
          ? payload.type
          : undefined)
      let type = typeof named === "string" && EVENT_TYPE.test(named) ? named : "other"
      if (!counts.has(type) && counts.size >= MAX_EVENT_TYPES) type = "other"
      counts.set(type, (counts.get(type) ?? 0) + 1)
    },
    counts: (): Readonly<Record<string, number>> => Object.fromEntries(counts),
  }
}

export type EventTally = ReturnType<typeof createEventTally>

/**
 * The driver's stream-cap signal when this failure is the upstream dropping a stream that never
 * completed after at least `minMs`, else undefined. A router clock, a client cancel, a shutdown or a
 * translation failure is never the upstream's cap.
 */
export function streamCapSignal(
  descriptor: ResponseObservationDescriptor | undefined,
  error: unknown,
  terminal: ResponseObserver["terminal"],
  timing: { readonly streamMs: number; readonly minMs: number | undefined },
): string | undefined {
  const cap = descriptor?.streamCap
  if (cap === undefined || terminal === "completed") return undefined
  if (timing.streamMs < (timing.minMs ?? DEFAULT_STREAM_CAP_MIN_MS)) return undefined
  if (
    error instanceof ClientCancelledError ||
    error instanceof RouterShutdownError ||
    error instanceof TranslationStreamError ||
    (error instanceof Error && error.name === "TimeoutError")
  )
    return undefined
  return cap.signal
}
