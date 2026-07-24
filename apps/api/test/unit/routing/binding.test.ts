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

  test("a cooling-down account blocks the request instead of moving the conversation", () => {
    expect(decide(cooling, "bound")).toEqual({
      state: "blocked",
      accountId: "bound",
      resetsAt: at(600_000),
    })
  })

  test("a spent quota window is the same kind of temporary", () => {
    const spent = [subscription("bound", { quotaWindows: [continuous(1)] }), subscription("other")]
    expect(decide(spent, "bound").state).toBe("blocked")
  })

  test("`rebind` is opt-in and invalidates instead of waiting", () => {
    expect(decide(cooling, "bound", { boundAccountCoolingDown: "rebind" })).toEqual({
      state: "invalidated",
      accountId: "bound",
      reason: "cooling-down",
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
