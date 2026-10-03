import { describe, expect, test } from "bun:test"
import { RoutingPolicy } from "@multi-ai-router/core"
import { selectAccounts } from "../../../src/services/routing"
import { account, at, health, ids, pool, snapshot } from "./fixtures"

const request = {
  model: "sonnet",
  sessionKey: "conversation",
  keyScope: { kind: "pools" as const, poolIds: ["team"] },
  binding: { accountId: "overflow" },
}

describe("an established overflow session", () => {
  for (const policy of RoutingPolicy.options) {
    test(`stays on its healthy overflow after a primary recovers under ${policy}`, () => {
      const result = selectAccounts(
        snapshot(
          [account("primary"), account("overflow")],
          [pool("team", ["primary", "overflow"], { policy, overflowAccountId: "overflow" })],
        ),
        request,
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.decision.binding.state).toBe("honored")
      expect(ids(result.candidates)).toEqual(["overflow", "primary"])
      expect(result.decision.usedOverflow).toBe(true)
    })
  }

  test("a removed overflow membership cannot be restored by its binding", () => {
    const result = selectAccounts(
      snapshot(
        [account("primary"), account("overflow")],
        [pool("team", ["primary"], { overflowAccountId: "overflow" })],
      ),
      request,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ids(result.candidates)).toEqual(["primary"])
    expect(result.decision.binding).toMatchObject({ state: "invalidated", reason: "out-of-scope" })
  })

  test("a disabled overflow is invalidated and permits a fresh primary session", () => {
    const result = selectAccounts(
      snapshot(
        [account("primary"), account("overflow", { status: "disabled" })],
        [pool("team", ["primary", "overflow"], { overflowAccountId: "overflow" })],
      ),
      request,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(ids(result.candidates)).toEqual(["primary"])
    expect(result.decision.binding.state).toBe("invalidated")
  })

  test("a cooling overflow keeps the established session blocked", () => {
    const result = selectAccounts(
      snapshot(
        [
          account("primary"),
          account("overflow", {
            status: "cooling_down",
            health: health({ cooldownUntil: at(30_000) }),
          }),
        ],
        [pool("team", ["primary", "overflow"], { overflowAccountId: "overflow" })],
      ),
      request,
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(429)
    expect(result.decision.binding.state).toBe("blocked")
  })
})
