import { describeError } from "@multi-ai-router/core"
import type { AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../../logging/logger"
import { redactValue } from "../../../logging/redact"
import {
  type RefreshExpectation,
  type RefreshFlightObservation,
  type RefreshTimerState,
  sameExpectation,
  timingAfterException,
} from "./identity"

/** Process-local quarantine survives timer removal; only authoritative replacement clears it. */
export function createRefreshSafety(deps: {
  timings: Map<string, RefreshTimerState>
  armAt: (id: string, timing: RefreshTimerState) => void
  disarm: (id: string) => void
  now: () => Date
  minDelayMs: number
  barrier: () => Promise<void>
  abandoned: () => boolean
  log: (message: string, error: unknown, id?: string) => void
}) {
  const uncertain = new Map<string, string | null>()
  const retryHeld = (id: string): void => {
    const held = deps.timings.get(id)
    if (
      held === undefined ||
      held.pausedLifecycleVersion !== undefined ||
      (uncertain.has(id) && uncertain.get(id) === held.authMaterial)
    )
      return
    held.dueAtMs = Math.max(held.dueAtMs, deps.now().getTime() + deps.minDelayMs)
    deps.armAt(id, held)
  }
  return {
    retryHeld,
    deleted: (id: string) => {
      uncertain.delete(id)
    },
    blocked: (row: AccountRow): boolean => {
      if (!uncertain.has(row.id)) return false
      if (uncertain.get(row.id) === row.authMaterial) return true
      uncertain.delete(row.id)
      return false
    },
    failed: async (
      id: string,
      expected: RefreshExpectation | undefined,
      observation: RefreshFlightObservation,
      aborted: boolean,
      error: unknown,
    ): Promise<void> => {
      if (observation.exchangeFinished) {
        const held = deps.timings.get(id)
        if (
          !aborted &&
          held !== undefined &&
          expected !== undefined &&
          sameExpectation(held, expected)
        )
          retryHeld(id)
        return
      }
      const timing = deps.timings.get(id)
      if (observation.exchangeStarted && observation.row !== undefined) {
        // A concurrent replacement must not be overwritten by the old flight's quarantine.
        if (timing === undefined || timing.authMaterial === observation.row.authMaterial) {
          uncertain.set(id, observation.row.authMaterial)
          deps.disarm(id)
        }
        deps.log(
          "credential refresh writeback uncertain; unchanged credential requires reauthorization",
          error,
          id,
        )
        if (!aborted && !deps.abandoned()) await deps.barrier()
        return
      }
      if (aborted) return
      const action = timingAfterException(
        timing,
        expected,
        observation,
        deps.now().getTime(),
        deps.minDelayMs,
      )
      if (action === "retry" && timing !== undefined) deps.armAt(id, timing)
    },
  }
}

export function refreshErrorLogger(logger: Logger) {
  return (message: string, error: unknown, id?: string): void => {
    logger.warn(message, {
      component: "account-refresher",
      ...(id === undefined ? {} : { accountId: id }),
      error: redactValue(describeError(error, Number.POSITIVE_INFINITY)).slice(0, 200),
    })
  }
}
