import type { z } from "zod"

/** The attempt deadline's default (`routing-env.ts`), read here only when the operator left it unset. */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 600_000

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
}

/**
 * Refuses a wait that cannot do its job: past {@link CLAUDE_QUEUE_WAIT_MAX_MS} the client is gone
 * before the answer, and at or past the attempt deadline (`UPSTREAM_TIMEOUT_MS`) the deadline
 * ends the request first, so the budget never expires and nothing is ever told the gate was full.
 * (A value past the timer range is already refused by `numeric-bounds.ts`.)
 *
 * The refusal is for a value the operator SET. An unset knob is a default the operator never chose,
 * so a deployment that only lowered `UPSTREAM_TIMEOUT_MS` below it must still boot: the default is
 * `min(60000, floor(deadline / 2))`, half the attempt timeout rounded down with a 60 s cap, so it starts
 * to shrink below a 120000 ms deadline (90000 gives 45000) and the wait still expires first. A deadline
 * of 2 ms or less leaves no room for any wait (half of it rounded down, floored at 1 ms, would tie
 * or nearly tie the deadline, and a saturated gate could time out before its capacity verdict), so
 * the derived wait is 0: the gate admits at once or refuses at once, never queues, and the capacity
 * verdict comes back before the deadline. Boot stays compatible, since only a SET value is refused.
 */
export function readClaudeQueueWaitMs(raw: QueueWaitEnv, ctx: z.RefinementCtx): number {
  const deadlineMs = raw.UPSTREAM_TIMEOUT_MS ?? DEFAULT_UPSTREAM_TIMEOUT_MS
  if (raw.CLAUDE_SDK_QUEUE_WAIT_MS === undefined)
    return deadlineMs <= 2 ? 0 : Math.min(DEFAULT_QUEUE_WAIT_MS, Math.floor(deadlineMs / 2))
  const waitMs = raw.CLAUDE_SDK_QUEUE_WAIT_MS
  const issue = (message: string) =>
    ctx.addIssue({ code: "custom", path: ["CLAUDE_SDK_QUEUE_WAIT_MS"], message })
  if (waitMs > CLAUDE_QUEUE_WAIT_MAX_MS)
    issue(
      `must be at most ${CLAUDE_QUEUE_WAIT_MAX_MS}: clients cut a silent call at 300 s, so a longer wait answers after the client has gone`,
    )
  else if (waitMs >= deadlineMs)
    issue(
      `must be less than UPSTREAM_TIMEOUT_MS (${deadlineMs}): the attempt deadline would end the request before the wait could`,
    )
  return waitMs
}
