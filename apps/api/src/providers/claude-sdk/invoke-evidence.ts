import type { ScrubRuleName } from "./scrub"

/**
 * What one Claude invoker says of the upstream attempt it starts, for the attempt-failed log line
 * (`services/dataplane/attempt-log.ts`, #509). Names and numbers only: never a word of the prompt.
 */
export interface SdkTransportReport {
  /** The invoker that sends this attempt: the direct HTTP transport, or the Agent SDK. */
  readonly transport: "fast" | "sdk"
  /** The model name that invoker sends upstream. */
  readonly model: string
  /**
   * The scrub rules that changed the system prompt sent, in table order (`scrub.ts`). `[]` when the
   * scrub ran and nothing matched; absent when it never ran (no system text was sent).
   */
  readonly scrubRules?: readonly ScrubRuleName[]
}

/**
 * What a fast-transport refusal holds only inside `refuse()`: the account gate's count with the
 * refused request still holding its slot, and the upstream's real headers, which the synthesized
 * error `Response` no longer carries (`claude-fast/response.ts`, `safeError`).
 */
export interface SdkRefusalEvidence {
  readonly inFlight: number
  readonly headers: Headers
}
