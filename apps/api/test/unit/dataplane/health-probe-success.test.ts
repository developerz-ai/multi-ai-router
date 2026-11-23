import { describe, expect, test } from "bun:test"
import type { AccountBreakerRow } from "@multi-ai-router/db"
import { createHealthStore } from "../../../src/services/dataplane/health"
import type { HealthAccountFacts } from "../../../src/services/dataplane/health-observation"

/**
 * Prod 2026-11-23, 2.76.0: a cooled Claude account answered 200 every ~35 s and the next request was
 * refused every time. The probe's own bookkeeping (its hold, and the limiter reading its answer
 * carried) moved the breaker revision, so the probe's success was judged stale and dropped. The
 * repository half (a hold leaves the revision alone) is in `packages/db` `account-breaker.test.ts`.
 */
const ID = "a"
const T0 = new Date("2026-11-23T22:20:00.000Z")
const COOLED = new Date(T0.getTime() + 60_000)
const AFTER = new Date(T0.getTime() + 90_000)

const row = (over: Partial<AccountBreakerRow> = {}): AccountBreakerRow => ({
  accountId: ID,
  revision: 7,
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  credentialFingerprint: "digest",
  status: "cooling_down",
  cooldownUntil: COOLED,
  cooldownSource: "estimated",
  cooldownReason: null,
  consecutiveFailures: 9,
  probeHeldUntil: null,
  capturedGeneration: null,
  ...over,
})
const facts = (breaker: AccountBreakerRow): HealthAccountFacts => ({
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: null,
  status: "active",
  breaker,
})

function cooled() {
  const published: string[] = []
  const health = createHealthStore({ onBreaker: (_id, breaker) => published.push(breaker.status) })
  health.reconcile(ID, facts(row()))
  expect(health.stateOf(ID).breaker.status).toBe("cooling_down")
  return { health, published }
}

describe("a half-open probe's success", () => {
  test("a catalog refresh that only carries the probe's own hold does not fence it", () => {
    const { health } = cooled()
    const observation = health.captureAttempt(ID, facts(row()))
    const probe = health.admitProbe(ID, AFTER)
    expect(probe).toMatchObject({ admitted: true, held: true })
    health.reconcile(ID, facts(row({ probeHeldUntil: new Date(AFTER.getTime() + 30_000) })))

    health.recordSuccess(ID, observation)

    expect(health.stateOf(ID).breaker.status).toBe("active")
  })

  test("a limiter reading that changes nothing is not published", () => {
    const { health, published } = cooled()
    const observation = health.captureAttempt(ID, facts(row()))
    health.applyRateLimit(
      ID,
      { limited: false, resetSource: "unknown", windows: [] },
      AFTER,
      observation,
    )
    expect(published).toEqual([])

    health.recordSuccess(ID, observation)

    expect(published).toEqual(["active"])
    expect(health.stateOf(ID).breaker.status).toBe("active")
  })

  test("a verdict another replica stored meanwhile still fences it", () => {
    const { health } = cooled()
    const observation = health.captureAttempt(ID, facts(row()))
    health.reconcile(
      ID,
      facts(row({ revision: 8, cooldownUntil: new Date(AFTER.getTime() + 600_000) })),
    )

    health.recordSuccess(ID, observation)

    expect(health.stateOf(ID).breaker.status).toBe("cooling_down")
  })

  test("another replica's hold is still honoured, and its release frees the gate", () => {
    const { health } = cooled()
    health.reconcile(ID, facts(row({ probeHeldUntil: new Date(AFTER.getTime() + 30_000) })))
    expect(health.admitProbe(ID, AFTER).admitted).toBe(false)
    health.reconcile(ID, facts(row()))
    expect(health.admitProbe(ID, AFTER).admitted).toBe(true)
  })
})
