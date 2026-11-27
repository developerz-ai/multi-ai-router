import type { z } from "zod"

import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "../services/dataplane/dispatcher-config"
import { DEFAULT_UPSTREAM_STREAM_TIMEOUT_MS } from "./upstream-stream"

/**
 * The most `CLAUDE_SDK_QUEUE_WAIT_MS` may be: 240 s. Clients cut a silent call at 300 s, and the
 * wait is spent before a single byte can answer them, so a budget near that cut returns its
 * `429 account_at_capacity` / `503 router-at-capacity` after the client has already hung up and the
 * feature fails the way the unbounded queue did. 60 s of headroom keeps the answer inside the cut
 * with room for the walk's own work around it. Raising it is a code change on purpose.
 */
export const CLAUDE_QUEUE_WAIT_MAX_MS = 240_000

/** The wait when the operator set none: a minute, unless the attempt deadline leaves less room. */
const DEFAULT_QUEUE_WAIT_MS = 60_000

type QueueWaitEnv = {
  readonly CLAUDE_SDK_QUEUE_WAIT_MS?: number
  readonly UPSTREAM_TIMEOUT_MS?: number
  readonly UPSTREAM_STREAM_TIMEOUT_MS?: number
}

/**
 * The one rule bounding the wait. D is the shortest clock that can end the attempt that is queued:
 * `min(UPSTREAM_TIMEOUT_MS, UPSTREAM_STREAM_TIMEOUT_MS)`. A streamed fast-mode attempt's total clock
 * starts before the gate wait, and the SDK/non-streamed deadline is `UPSTREAM_TIMEOUT_MS`, so the
 * shorter of the two ends the request first. The wait may use at most half of D, which leaves the
 * other half as HEADROOM for the work that spends none of the budget (parsing, and a
 * credential-refresh wait before the gate timer starts). Headroom is not a guarantee: it covers
 * that work only when D >= 2 x the work, and the refresh wait alone can take up to
 * `CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS` (default 20000), so below a D of 40000 an expiring wait
 * can still be pushed past D and the attempt time out before it returns a capacity verdict. A
 * larger operator-set refresh wait is outside this rule altogether. Never above
 * {@link CLAUDE_QUEUE_WAIT_MAX_MS}, and 0 for a D of 2 ms or less (half of it, floored at 1 ms,
 * would tie the deadline).
 */
export function claudeQueueWaitCeilingMs(deadlineMs: number): number {
  return deadlineMs <= 2 ? 0 : Math.min(CLAUDE_QUEUE_WAIT_MAX_MS, Math.floor(deadlineMs / 2))
}

/**
 * Refuses a wait above {@link claudeQueueWaitCeilingMs}: past 240000 the client is gone before the
 * answer, and past half of D the deadline can end the request first, so the budget never expires and
 * nothing is ever told the gate was full. The message names the value and, unless the ceiling is the 240000 cap (D of 480000 ms or more), D and the knob that set D (a tie names both).
 * (A value past the timer range is already refused by `numeric-bounds.ts`.)
 *
 * The refusal is for a value the operator SET. An unset knob is a default the operator never chose,
 * so a deployment that only lowered a deadline must still boot: the default is
 * `min(60000, ceiling)`, which starts to shrink below a 120000 ms D (90000 gives 45000). That
 * default is headroom, not a guarantee, for the reason above: with D below 40000 the pre-gate work
 * can still outlast the shortened wait. A D of 2 ms or less leaves no room for any wait, so the
 * derived wait is 0: the gate admits at once or refuses at once, never queues.
 */
export function readClaudeQueueWaitMs(raw: QueueWaitEnv, ctx: z.RefinementCtx): number {
  const attemptMs = raw.UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  const streamMs = raw.UPSTREAM_STREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_STREAM_TIMEOUT_MS
  const deadlineMs = Math.min(attemptMs, streamMs)
  const ceilingMs = claudeQueueWaitCeilingMs(deadlineMs)
  if (raw.CLAUDE_SDK_QUEUE_WAIT_MS === undefined) return Math.min(DEFAULT_QUEUE_WAIT_MS, ceilingMs)
  const waitMs = raw.CLAUDE_SDK_QUEUE_WAIT_MS
  if (waitMs > ceilingMs) {
    const setBy =
      streamMs === attemptMs
        ? "UPSTREAM_TIMEOUT_MS and UPSTREAM_STREAM_TIMEOUT_MS"
        : streamMs < attemptMs
          ? "UPSTREAM_STREAM_TIMEOUT_MS"
          : "UPSTREAM_TIMEOUT_MS"
    const why =
      ceilingMs === 0
        ? `an attempt deadline of ${deadlineMs} ms leaves no room for any wait (set by ${setBy}); unset the wait for a zero wait, or raise ${setBy}`
        : ceilingMs === CLAUDE_QUEUE_WAIT_MAX_MS
          ? "clients cut a silent call at 300 s, so a longer wait answers after the client has gone"
          : `the wait may use at most half of the attempt deadline of ${deadlineMs} ms (set by ${setBy}), the rest being spent before and after it; lower the wait or raise ${setBy}`
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_SDK_QUEUE_WAIT_MS"],
      message: `${waitMs} must be at most ${ceilingMs}: ${why}`,
    })
  }
  return waitMs
}
