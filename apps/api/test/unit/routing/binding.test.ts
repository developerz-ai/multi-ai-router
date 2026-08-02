/**
 * The Session -> Account binding, decided as an input rather than produced as a side effect.
 *
 * The table in `02-domain-model.md` is the contract: `cooling_down` keeps the binding, every
 * other exit invalidates it, and an invalidated binding means a *restarted* conversation, never
 * a relocated one.
 */

import { describe, expect, test } from "bun:test"
import type {
  AccountSnapshot,
  BindingInvalidationReason,
  SelectionOptions,
  SelectionRequest,
} from "../../../src/services/routing"
import { decideBinding, resolveScope } from "../../../src/services/routing"
import { account, at, continuous, health, pool, snapshot, subscription } from "./fixtures"

const request: SelectionRequest = {
  sessionKey: "session-alpha",
  model: "sonnet",
  keyScope: { kind: "pools", poolIds: ["team"] },
}

function decide(
  accounts: readonly AccountSnapshot[],
  boundAccountId: string | undefined,
  options: SelectionOptions = {},
  keyScope: SelectionRequest["keyScope"] = request.keyScope,
) {
  const state = snapshot(accounts, [pool("team", ["bound", "other"])])
  const scoped = { ...request, keyScope }
  const { groups } = resolveScope(state, scoped, options)
  return decideBinding(state, groups, boundAccountId, scoped.model, options)
}

const healthy = [subscription("bound"), subscription("other")]

test("no binding leaves the policy to place the session", () => {
  expect(decide(healthy, undefined)).toEqual({ state: "none" })
})

test("an eligible bound account is honored", () => {
  expect(decide(healthy, "bound")).toEqual({ state: "honored", accountId: "bound" })
})

describe("kept, because a clock will fix it", () => {
  const cooling = [
    subscription("bound", {
      status: "cooling_down",
      health: health({ cooldownUntil: at(600_000) }),
    }),
    subscription("other"),
  ]

  const probed = [
    subscription("bound", {
      status: "cooling_down",
      health: health({ cooldownUntil: at(-1_000), probeHeldUntil: at(20_000) }),
    }),
    subscription("other"),
  ]

  test("a cooling-down account blocks the request instead of moving the conversation", () => {
    expect(decide(cooling, "bound")).toEqual({
      state: "blocked",
      accountId: "bound",
      reason: "cooling-down",
      resetsAt: at(600_000),
    })
  })

  test("a spent quota window is the same kind of temporary — and named as itself, not as cooling", () => {
    const spent = [subscription("bound", { quotaWindows: [continuous(1)] }), subscription("other")]
    const decision = decide(spent, "bound")
    expect(decision.state).toBe("blocked")
    if (decision.state === "blocked") expect(decision.reason).toBe("quota-window-spent")
  })

  test("another request's probe on the bound account is the shortest clock of all", () => {
    // Milliseconds, not minutes: the probe either brings the account back or cools it down again.
    // Dropping a resumable conversation over that would restart it for nothing.
    expect(decide(probed, "bound")).toEqual({
      state: "blocked",
      accountId: "bound",
      reason: "probe-in-flight",
      resetsAt: at(20_000),
      // The router's own hold, not anything the provider said — the 429 must say so.
      resetSource: "estimated",
    })
  })

  test("`rebind` never fires on a probe in flight — the shortest clock is always worth the wait", () => {
    // The failure this pins: `rebind` inverting the *whole* clock-recoverable set dropped a
    // resumable conversation over a hold the router itself placed and settles within one request.
    expect(decide(probed, "bound", { boundAccountCoolingDown: "rebind" })).toEqual({
      state: "blocked",
      accountId: "bound",
      reason: "probe-in-flight",
      resetsAt: at(20_000),
      resetSource: "estimated",
    })
  })

  test("`rebind` is opt-in and invalidates instead of waiting", () => {
    expect(decide(cooling, "bound", { boundAccountCoolingDown: "rebind" })).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason: "cooling-down",
    })
  })

  test("`rebind` also covers a spent quota window — the commit that shipped it names both", () => {
    const spent = [subscription("bound", { quotaWindows: [continuous(1)] }), subscription("other")]
    expect(decide(spent, "bound", { boundAccountCoolingDown: "rebind" })).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason: "quota-window-spent",
    })
  })
})

describe("invalidated, because no clock returns the account", () => {
  const cases: readonly [string, AccountSnapshot, BindingInvalidationReason][] = [
    ["exhausted", subscription("bound", { status: "exhausted" }), "exhausted"],
    ["needs_reauth", subscription("bound", { status: "needs_reauth" }), "needs-reauth"],
    ["disabled", subscription("bound", { status: "disabled" }), "disabled"],
    [
      "the model is no longer supported",
      subscription("bound", { supportedModels: ["opus"] }),
      "model-unsupported",
    ],
  ]

  test.each(cases)("%s", (_name, entry, reason) => {
    expect(decide([entry, subscription("other")], "bound")).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason,
    })
  })

  test("an account removed from the snapshot entirely", () => {
    expect(decide([subscription("other")], "bound")).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason: "account-missing",
    })
  })

  test("scope always wins — a binding can never reach an account the key may not use", () => {
    const decision = decide(healthy, "bound", {}, { kind: "accounts", accountIds: ["other"] })
    expect(decision).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason: "out-of-scope",
    })
  })
})

test("the plain HTTP path is judged the same way — the binding is simply optional there", () => {
  const http = [account("bound"), account("other")]
  expect(decide(http, "bound")).toEqual({ state: "honored", accountId: "bound" })
})
