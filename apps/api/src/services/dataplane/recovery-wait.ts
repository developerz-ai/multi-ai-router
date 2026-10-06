import type { RouterError } from "@multi-ai-router/core"
import type { Logger } from "../../logging/logger"
import type { RejectedCandidate, SelectionDecision, SelectionResult } from "../routing"
import type { ActiveRequestLease } from "./active-requests"
import { isAwaitingRecoveryPermit, owesRefusalRecord } from "./chain-refusals"
import type { RecoveryWaitOptions } from "./dispatcher-config"
import type { DataPlaneClock } from "./types"

/**
 * The bounded in-request wait for the router's **own** recovery hold.
 *
 * `probe-in-flight` with an `estimated` reset is not a provider verdict: it is a recovery awaiting
 * its permit from the coordinator, or another request's half-open probe, and either settles within
 * a coordinator tick or one request. Answering `429` there sent the client away from an account
 * that was about to be good (prod, 2026-10-06 23:15). The rule instead: the request may take
 * longer, but it lands on a good account — re-select on the coordinator's cadence for at most
 * `RECOVERY_REQUEST_WAIT_MS`, then fail honestly with the last selection's own error.
 *
 * Only ever entered after a selection (or a chain) already failed, so the served path pays nothing.
 */

type Hold = Pick<RejectedCandidate, "reason" | "resetsAt" | "resetSource">

/** A router-owned hold that may release before `deadline` — the only thing worth waiting for. */
function isRouterHold(entry: Hold, deadline: Date): boolean {
  return (
    entry.reason === "probe-in-flight" &&
    entry.resetSource === "estimated" &&
    (entry.resetsAt === undefined || entry.resetsAt.getTime() <= deadline.getTime())
  )
}

/**
 * Whether waiting until `deadline` could turn this failed selection into a served request.
 *
 * A blocked binding names the one account the request may use, so only its own hold counts.
 * Otherwise every in-scope account was rejected, and one router-held account is enough: the
 * spent, exhausted, or unauthenticated ones beside it cannot serve inside the budget either way,
 * while the held one may within a tick. A hold released only after `deadline` (a failed recovery's
 * `nextAllowedAt`) is not waited for — that `429` is already the honest answer.
 */
export function awaitsRouterRecovery(decision: SelectionDecision, deadline: Date): boolean {
  const binding = decision.binding
  if (binding.state === "blocked") return isRouterHold(binding, deadline)
  return decision.rejected.some((entry) => isRouterHold(entry, deadline))
}

export type Sleep = (milliseconds: number, signal: AbortSignal) => Promise<void>

/** A timer that rejects with the signal's reason the moment the client goes away. */
export const sleepUnlessAborted: Sleep = (milliseconds, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)
    signal.addEventListener("abort", onAbort, { once: true })
  })

export interface RecoveryWaiter {
  /** Wall-clock instant the remaining budget reaches, read from `now`. */
  deadline(now: Date): Date
  /** Sleeps one interval within the budget; false, without sleeping, once it is spent. */
  pause(): Promise<boolean>
}

/** One budget per request, shared by every re-selection and chain retry it makes. */
export function createRecoveryWaiter(deps: {
  readonly options: RecoveryWaitOptions | undefined
  readonly clock: DataPlaneClock
  readonly sleep: Sleep
  readonly signal: AbortSignal
  readonly log?: Logger | undefined
}): RecoveryWaiter {
  const budgetMs = deps.options?.budgetMs ?? 0
  const intervalMs = Math.max(1, deps.options?.intervalMs ?? 250)
  let started: number | undefined
  const remaining = () =>
    started === undefined ? budgetMs : Math.max(0, budgetMs - (deps.clock.elapsed() - started))
  return {
    deadline: (now) => new Date(now.getTime() + remaining()),
    async pause() {
      const left = remaining()
      if (left <= 0) return false
      if (started === undefined) {
        started = deps.clock.elapsed()
        deps.log?.info("waiting for a recovery permit", { budgetMs })
      }
      await deps.sleep(Math.min(intervalMs, left), deps.signal)
      return true
    },
  }
}

/** Re-select while the only obstacle is a router-owned hold the budget can outlast. */
export async function selectThroughRecovery(
  select: () => SelectionResult,
  waiter: RecoveryWaiter,
  now: () => Date,
): Promise<SelectionResult> {
  for (;;) {
    const selection = select()
    if (selection.ok || !awaitsRouterRecovery(selection.decision, waiter.deadline(now()))) {
      return selection
    }
    if (!(await waiter.pause())) return selection
  }
}

/**
 * A lease whose `release` is held while a chain runs. The chain releases it on its way to the
 * "awaiting a recovery permit" refusal; a request about to wait and retry is still active, and a
 * released lease is one shutdown would neither abort nor drain.
 */
export function holdLease(lease: ActiveRequestLease | undefined) {
  let held = true
  let requested = false
  const wrapped: ActiveRequestLease | undefined =
    lease === undefined
      ? undefined
      : {
          signal: lease.signal,
          setAbandon: (callback) => lease.setAbandon(callback),
          release: () => {
            if (held) requested = true
            else lease.release()
          },
        }
  return {
    lease: wrapped,
    /** The chain settled for good: a release it asked for happens now, later ones pass through. */
    settle() {
      held = false
      if (requested) lease?.release()
    },
    /** The chain will run again: forget the release the refused one asked for. */
    keep() {
      requested = false
    },
  }
}

/**
 * Runs one chain. A refusal that only awaits a permit is retried by the caller (`"retry"`) while
 * the budget lasts; on give-up `fail` writes its single `UsageRecord` when no attempt did.
 */
export async function runChainThroughRecovery(
  run: () => Promise<Response>,
  waiter: RecoveryWaiter,
  lease: ReturnType<typeof holdLease>,
  fail: (error: RouterError) => never,
  rows: { attempted: boolean },
): Promise<Response | "retry"> {
  let response: Response
  try {
    response = await run()
  } catch (error) {
    if (!isAwaitingRecoveryPermit(error)) {
      lease.settle()
      throw error
    }
    // Rows are per request: once any chain's attempt wrote one, no later refusal owes its own.
    rows.attempted ||= !owesRefusalRecord(error)
    let again = false
    try {
      again = await waiter.pause()
    } finally {
      if (again) lease.keep()
      else lease.settle()
    }
    if (again) return "retry"
    // An attempt already wrote this request's rows; the refusal only names the answer.
    if (rows.attempted) throw error
    return fail(error)
  }
  lease.settle()
  return response
}

/** Everything one request needs to wait out a recovery: one budget, one held lease. */
export function createRequestRecovery(deps: {
  readonly options: RecoveryWaitOptions | undefined
  readonly clock: DataPlaneClock
  readonly sleep: Sleep | undefined
  readonly signal: AbortSignal
  readonly log: Logger | undefined
  readonly lease: ActiveRequestLease | undefined
}) {
  const waiter = createRecoveryWaiter({ ...deps, sleep: deps.sleep ?? sleepUnlessAborted })
  const held = holdLease(deps.lease)
  const rows = { attempted: false }
  return {
    lease: held.lease,
    select: (select: () => SelectionResult) =>
      selectThroughRecovery(select, waiter, deps.clock.now),
    chain: (run: () => Promise<Response>, fail: (error: RouterError) => never) =>
      runChainThroughRecovery(run, waiter, held, fail, rows),
  }
}
