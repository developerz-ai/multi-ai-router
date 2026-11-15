import { describe, expect, test } from "bun:test"
import { createHealthStore, routableStandIn } from "../../../src/services/dataplane"
import { type PlanQuotaDeps, readPlanQuota } from "../../../src/services/models"
import { phase } from "../../../src/services/routing"
import { accountRow } from "../../support/account-row"

/**
 * The `openrouter-dz-coding-30d` case end to end, through the real plan read and health store with
 * a stubbed `GET /api/v1/key` and a clock the test moves: a $30 daily key cap spent at 18:31Z cools
 * the account until 00:00 UTC, and at 00:00 it is eligible again through the breaker's own
 * half-open transition — no second recovery path.
 */

const READ_AT = new Date("2026-11-14T18:30:00.000Z")
const MIDNIGHT = new Date("2026-11-15T00:00:00.000Z")
const KEY = "sk-or-v1-test-key-limit"

function routable() {
  const row = accountRow({
    id: "8b609813-f618-409c-85e9-60373a618fcf",
    label: "openrouter-dz-coding-30d",
    provider: "openrouter",
    billing: "metered",
    authMaterial: KEY,
  })
  return routableStandIn(row, {
    id: row.id,
    provider: row.provider,
    baseUrl: row.baseUrl,
    dialect: row.dialect,
    modelAliases: row.modelAliases,
  })
}

describe("a spent daily OpenRouter key cap recovers at 00:00 UTC", () => {
  test("read the key, refuse, cool until midnight, eligible at midnight", async () => {
    const clock = { now: READ_AT }
    const health = createHealthStore({ planReadingMaxAgeMs: 30 * 60_000 })
    const seen: Request[] = []
    const deps: PlanQuotaDeps = {
      cipher: { decrypt: (envelope: string) => envelope },
      timeoutMs: 5_000,
      fetch: async (request) => {
        seen.push(request)
        return Response.json({
          data: { label: "sk-or-v1-tes...", limit: 30, limit_reset: "daily", limit_remaining: 0 },
        })
      },
      health,
      now: () => clock.now,
    }
    const account = routable()

    expect(await readPlanQuota(deps, account)).toEqual({ kind: "read" })
    expect(seen[0]?.url).toBe("https://openrouter.ai/api/v1/key")
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`)
    // The reading alone never cools.
    expect(health.stateOf(account.id).breaker.status).toBe("active")

    const refusedAt = new Date("2026-11-14T18:31:00.000Z")
    health.recordFailure(
      account.id,
      { kind: "credits-exhausted", status: 402, message: "Key limit exceeded" },
      refusedAt,
    )
    const { breaker } = health.stateOf(account.id)
    expect(breaker.status).toBe("cooling_down")
    expect(breaker.cooldownUntil).toEqual(MIDNIGHT)
    expect(phase(breaker, new Date(MIDNIGHT.getTime() - 1))).toBe("open")
    expect(phase(breaker, MIDNIGHT)).toBe("half-open")
  })
})
