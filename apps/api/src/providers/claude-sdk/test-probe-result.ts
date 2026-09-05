import { classifySdkFailure } from "./errors"

/**
 * Reading a probe turn's `result` for an operator: the one sentence the "Test now" button shows,
 * and the bounded detail beside it. Split from `test-probe.ts` so the subprocess lifecycle and the
 * wording of its outcome change for different reasons.
 */

const MESSAGE_SNIPPET_LIMIT = 200

/**
 * What a failed turn actually says, in one sentence an operator can act on.
 *
 * **`subtype` alone is not the reason, and on the most important failure it is actively wrong.** A
 * spent Claude subscription comes back as `subtype: "success"` with `is_error: true` and the reason
 * in `result` — so rendering the subtype produced the self-contradiction "the Claude Agent SDK turn
 * did not succeed (success)" while discarding the one field that explained it. Observed on a live
 * account whose window was at 100%.
 *
 * So `result` leads, through the same `classifySdkFailure` table the dispatch path uses: a usage
 * limit reads as "the account's Claude subscription window is spent", an expired credential as
 * "needs re-authenticating", and each keeps the wording the client would have received, so the
 * button and the data plane never describe one condition two ways. A turn that failed with nothing
 * quotable falls back to the subtype, which is at least honest for `error_max_turns` and friends.
 */
/**
 * Absent rather than empty when the upstream said nothing — there is no detail to record.
 *
 * Takes the message rather than the field for the same reason {@link resultFailureMessage} does:
 * only the SDK's *success* result variant declares `result`, and the failure we care most about
 * (`subtype: "success"` with `is_error: true`) is that variant. A structurally-typed parameter
 * reads it off either without narrowing the union by hand.
 */
export function detailOf(stated: string | undefined): { reasonDetail?: string } {
  const trimmed = stated?.trim()
  if (trimmed === undefined || trimmed === "") return {}
  return { reasonDetail: snippet(trimmed) }
}

/**
 * The `result` text, read off whichever result variant carries one — only the SDK's *success*
 * variant declares it, and the failure that matters most (`subtype: "success"` with
 * `is_error: true`) is that variant.
 *
 * `subtype` is in the parameter type purely to make this assignable: a shape whose properties are
 * all optional is a *weak type*, and the error variant — which has no `result` at all — shares no
 * property with it and is rejected. One field both variants declare is enough to anchor it.
 */
export function statedResult(message: {
  readonly subtype: string
  readonly result?: string
}): string | undefined {
  return message.result
}

export function resultFailureMessage(message: {
  readonly subtype: string
  readonly result?: string
}): string {
  const stated = message.result?.trim()
  if (stated !== undefined && stated !== "") return classifySdkFailure(stated).clientMessage
  return `the Claude Agent SDK turn did not succeed (${message.subtype})`
}

export function snippet(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MESSAGE_SNIPPET_LIMIT
    ? trimmed
    : `${trimmed.slice(0, MESSAGE_SNIPPET_LIMIT)}…`
}
