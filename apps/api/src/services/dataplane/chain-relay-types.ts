import type { Logger } from "../../logging/logger"
import type { TranslationContext } from "../translate/registry"
import type { HealthObservation } from "./health-observation"
import type { RecoveryAttempt } from "./recovery-access"
import type { DispatchRuntime } from "./runtime"

/** The shapes `chain-relay.ts` settles an attempt against, split so the relay itself stays one job. */

export interface AttemptClock {
  readonly startedAt: Date
  readonly started: number
  readonly upstreamMs: number
}

/**
 * An `AttemptClock` plus the moment this attempt's upstream span opened — the reading the chain
 * takes once the request body exists and before either transport is called.
 *
 * It is a separate reading from `started` because the two answer different questions. `started`
 * bounds the *attempt*, so `latencyMs` includes the conversion the router ran for it;
 * `upstreamStarted` bounds the *wait*, so `routerOverheadMs` does not. A failure closes its span in
 * the chain; a success cannot, because the stream settles long after the chain returned — so it
 * carries the open end here and `settle` closes it at the last relayed byte.
 */
export interface SuccessClock extends AttemptClock {
  readonly releaseProbe?: () => void
  readonly rateLimited?: boolean
  readonly isRateLimited?: () => boolean
  readonly onSettled?: () => void
  readonly recovery?: RecoveryAttempt
  readonly upstreamStarted: number
  /** The tool this attempt's request forces on a vendor that ignores a force (`forced-tool-coercion.ts`). */
  readonly forcedTool?: string
  readonly observation?: HealthObservation
}

/**
 * The slice of the chain's context an attempt's accounting reads. `ChainContext` satisfies it
 * structurally, so the chain passes itself and nothing has to be threaded or rebuilt.
 */
export interface AttemptRelay {
  readonly runtime: DispatchRuntime
  readonly translation: TranslationContext
  readonly translated?: Pick<
    import("./translate-body").TranslatedRequestBody,
    "includeUsage" | "clientStreams"
  >
  readonly log: Logger | undefined
  /**
   * The bound for `upstreamMessage` on a settle-path warn line — the operator's
   * `LOG_REASON_MAX_CHARS`. Absent falls back to {@link DEFAULT_LOG_REASON_MAX_CHARS}, the
   * value every other quoted reason in the process uses.
   */
  readonly reasonMaxChars?: number
  readonly request?: Request
}
