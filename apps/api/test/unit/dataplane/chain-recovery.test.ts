/**
 * `recordChainFailure` (`services/dataplane/chain-recovery.ts`).
 *
 * Prod fingerprint, 2026-10-13..15: account `b956ad43` (qwen3.8-max) had its quota reopen on 10-13
 * 20:58, but the designated recovery probe kept drawing a `400` ("tool_choice … not supported …
 * required/object in thinking mode") on forced-tool requests. `routing/breaker.ts` correctly leaves
 * the breaker untouched on a `client-error`, but this function recorded the probe `finish("failed")`
 * regardless of kind — re-gating the account ~30s (`next_allowed_at`) and keeping it half-open. Each
 * probe was followed ~1.4s later by a router-made `429` with an eligible account in scope (the
 * owner's rule: that is a bug), until a non-forced request finally succeeded on 10-15 20:36.
 *
 * A `client-error` / `model-unsupported` is the upstream judging the *request*, not the account, so
 * the probe proves the account healthy: `finish("succeeded")` + `recordSuccess`, never a failed probe.
 */
import { describe, expect, test } from "bun:test"
import type { AttemptOutcome } from "../../../src/services/dataplane/attempt"
import type { ChainContext } from "../../../src/services/dataplane/chain"
import { recordChainFailure } from "../../../src/services/dataplane/chain-recovery"
import type { HealthStore } from "../../../src/services/dataplane/health"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import type { ServableCandidate } from "../../../src/services/dataplane/plan"
import type { RecoveryAttempt } from "../../../src/services/dataplane/recovery-access"
import type { FailureKind } from "../../../src/services/routing"

const NOW = new Date("2026-10-15T20:00:00.000Z")
const OBSERVATION = undefined as unknown as HealthObservation

interface HealthCalls {
  readonly success: string[]
  readonly failure: string[]
  readonly rateLimit: string[]
}

function fakeHealth(): { store: HealthStore; calls: HealthCalls } {
  const calls: HealthCalls = { success: [], failure: [], rateLimit: [] }
  const store = {
    recordSuccess: (id: string) => calls.success.push(id),
    recordFailure: (id: string) => calls.failure.push(id),
    applyRateLimit: (id: string) => calls.rateLimit.push(id),
  } as unknown as HealthStore
  return { store, calls }
}

function fakeRecovery(designated: boolean): {
  attempt: RecoveryAttempt
  finished: Array<"succeeded" | "failed" | "uncertain">
} {
  const finished: Array<"succeeded" | "failed" | "uncertain"> = []
  const attempt: RecoveryAttempt = {
    designated,
    started: () => true,
    finish: (state) => finished.push(state),
  }
  return { attempt, finished }
}

function servable(): ServableCandidate {
  return {
    kind: "http",
    account: { id: "b956ad43" },
    driver: { authKind: undefined },
    candidate: { halfOpen: true },
  } as unknown as ServableCandidate
}

function failure(kind: FailureKind): Extract<AttemptOutcome, { kind: "failure" }> {
  return {
    kind: "failure",
    failure: { kind, status: kind === "model-unsupported" ? 404 : 400, message: "x" },
    classification: null,
    rateLimit: null,
    upstream: null,
  }
}

function run(
  health: HealthStore,
  recovery: RecoveryAttempt | undefined,
  outcome: Extract<AttemptOutcome, { kind: "failure" }>,
): void {
  const ctx = { runtime: { health } } as unknown as ChainContext
  recordChainFailure(ctx, servable(), outcome, NOW, OBSERVATION, recovery, true)
}

describe("a designated probe answered client-error / model-unsupported", () => {
  for (const kind of ["client-error", "model-unsupported"] as const) {
    test(`${kind}: the probe succeeds and the account is recorded healthy, never gated`, () => {
      const { store, calls } = fakeHealth()
      const { attempt, finished } = fakeRecovery(true)
      run(store, attempt, failure(kind))

      // The fix, failure case first: the old code recorded finish("failed"), which gated the
      // account and kept the half-open probe hold — the next request then saw no eligible account.
      expect(finished).toEqual(["succeeded"])
      expect(calls.success).toEqual(["b956ad43"])
      expect(calls.failure).toEqual([])
      expect(calls.rateLimit).toEqual([])
    })
  }
})

describe("a real account fault is still recorded as a failure", () => {
  for (const kind of ["rate-limited", "server-error", "credits-exhausted", "auth"] as const) {
    test(`${kind}: finish("failed") + recordFailure, as before`, () => {
      const { store, calls } = fakeHealth()
      const { attempt, finished } = fakeRecovery(true)
      run(store, attempt, failure(kind))

      expect(finished).toEqual(["failed"])
      expect(calls.failure).toEqual(["b956ad43"])
      expect(calls.success).toEqual([])
    })
  }
})

describe("an ordinary (non-probe) attempt", () => {
  test("a client-error records the account healthy without touching a recovery", () => {
    const { store, calls } = fakeHealth()
    run(store, undefined, failure("client-error"))
    expect(calls.success).toEqual(["b956ad43"])
    expect(calls.failure).toEqual([])
  })

  test("an SDK preparation that never started is a no-op", () => {
    const { store, calls } = fakeHealth()
    const notStarted: RecoveryAttempt = {
      designated: true,
      started: () => false,
      finish: () => {
        throw new Error("must not finish a probe that never started")
      },
    }
    run(store, notStarted, failure("client-error"))
    expect(calls).toEqual({ success: [], failure: [], rateLimit: [] })
  })
})
