import { describe, expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import { createLogger } from "../../../src/logging/logger"
import { createAccountStatusWriter } from "../../../src/services/dataplane"
import type { HealthObservation } from "../../../src/services/dataplane/health-observation"
import { accountRow } from "../../support/account-row"
import { NOW } from "./fixtures"

const observed: HealthObservation = {
  lifecycleVersion: 0,
  healthRecoveryVersion: 0,
  authRecoveryVersion: 0,
  authMaterial: null,
  status: "active",
  observationGeneration: 1,
  verdictVersion: 0,
}

function harness(committed: boolean) {
  const parked: string[] = []
  const writer = createAccountStatusWriter({
    accounts: {
      transitionObservedStatus: async ({ id, status }) =>
        committed ? accountRow({ id, status }) : undefined,
    },
    logger: createLogger({ level: "error", write: () => undefined }),
    flushIntervalMs: 1_000,
    now: () => NOW,
  })
  writer.attachParked((accountId) => parked.push(accountId))
  const park = async (status: AccountStatus) => {
    writer.record("a", status, observed)
    await writer.flush()
  }
  return { writer, parked, park }
}

describe("the parked listener", () => {
  test("recording alone tells nobody: the request path never reaches it", () => {
    const h = harness(true)

    h.writer.record("a", "needs_reauth", observed)

    expect(h.parked).toEqual([])
  })

  test("a committed needs_reauth is announced from the flush", async () => {
    const h = harness(true)

    await h.park("needs_reauth")

    expect(h.parked).toEqual(["a"])
  })

  test("a write another replica or a newer credential beat is not", async () => {
    const h = harness(false)

    await h.park("needs_reauth")

    expect(h.parked).toEqual([])
  })

  test("exhausted is never announced: no refresh tops up a balance", async () => {
    const h = harness(true)

    await h.park("exhausted")

    expect(h.parked).toEqual([])
  })
})
