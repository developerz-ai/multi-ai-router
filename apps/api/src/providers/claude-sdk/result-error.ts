/**
 * A `result` message that says the turn failed, raised as the failure it is.
 *
 * The SDK yields such a message rather than throwing: `is_error: true`, the API's own sentence in
 * `result` (or a list in `errors`), and — since 0.3.261 — the structured facts beside it, the
 * upstream HTTP status and the SDK's `terminal_reason`. Only when the subprocess then exits
 * non-zero does the SDK convert it into a throw, with the wording mirrored below. A subprocess that
 * exits cleanly after an error result therefore produced, before this class existed, a turn that
 * ended as a *success* carrying no content — or, when the exit was unclean, a throw whose text
 * (`Failed to authenticate: OAuth session expired and could not be refreshed`) matched no rule and
 * answered `502` with a healthy-looking account behind it. Production saw exactly that: three
 * subscriptions whose refresh tokens had hard-expired, reported as `active`, failing every
 * request as "a reason this router does not recognize" (docs/idea/11-anthropic-agent-sdk.md §9).
 *
 * The message is the SDK's own sentence shape on purpose, so one classification rule reads the
 * failure identically whichever of the two paths delivered it. The structured fields ride as
 * properties so `errors.ts` can prefer a fact over a phrase where the SDK stated one.
 */
export class SdkResultError extends Error {
  /** The upstream HTTP status the SDK reported for the failed API call, when it reported one. */
  readonly apiErrorStatus: number | null
  /** The SDK's own reason the turn stopped (`prompt_too_long`, `api_error`, …), when named. */
  readonly terminalReason: string | null
  /** The `result` sentence or joined `errors`, verbatim. Never rendered to a client. */
  readonly resultText: string

  constructor(input: {
    readonly text: string
    readonly apiErrorStatus: number | null
    readonly terminalReason: string | null
  }) {
    super(`${SDK_RESULT_ERROR_PREFIX}${input.text}`)
    this.name = "SdkResultError"
    this.resultText = input.text
    this.apiErrorStatus = input.apiErrorStatus
    this.terminalReason = input.terminalReason
  }
}

/**
 * Provenance: the Agent SDK's own wrapper (`Query.readMessages`, 0.3.220 through 0.3.261) — it
 * replaces a non-zero exit with `Error("Claude Code returned an error result: <text>")`. Blast
 * radius: a reworded SDK wrapper stops sharing this prefix, and the two delivery paths would then
 * be matched by their sentence bodies alone — which every rule in `errors.ts` already does.
 */
export const SDK_RESULT_ERROR_PREFIX = "Claude Code returned an error result: "
