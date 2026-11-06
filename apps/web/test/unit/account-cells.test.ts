import { describe, expect, test } from "bun:test"
import type { AccountView, PoolView, ProviderDescriptor } from "../../src/lib/api/types"
import {
  credentialLabel,
  credentialTone,
  disableConsequences,
  statusNextAction,
} from "../../src/routes/accounts/account-cells"

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "a",
    label: "go-sebastian",
    provider: "opencode-go",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 0,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  }
}

const KEY = { connectFlow: null, authKind: "api-key" } as ProviderDescriptor
const OAUTH = { connectFlow: "oauth", authKind: "oauth" } as ProviderDescriptor

function rejected(): AccountView {
  return account({
    status: "cooling_down",
    availability: {
      configuredStatus: "active",
      resetsAt: null,
      resetSource: "estimated",
      cooldownReason: "credential-rejected",
      lastCheckedAt: null,
      consecutiveFailures: 1,
      inFlight: 0,
      quotaWindows: [],
    },
  })
}

function pool(name: string, members: readonly [string, AccountView["status"]][]): PoolView {
  return {
    name,
    members: members.map(([accountId, status]) => ({ accountId, status })),
  } as unknown as PoolView
}

describe("statusNextAction", () => {
  test("exhausted names the top-up and the press that clears it", () => {
    expect(statusNextAction(account({ status: "exhausted" }), KEY)).toBe("top up, then Re-check")
  })

  test("needs_reauth on a login provider points at Reconnect", () => {
    expect(statusNextAction(account({ status: "needs_reauth" }), OAUTH)).toBe("press Reconnect")
  })

  test("needs_reauth with no login flow never points at a button that is not there", () => {
    expect(statusNextAction(account({ status: "needs_reauth" }), KEY)).toBe(
      "rotate the key in Edit",
    )
  })

  test("a refused key says where to rotate it", () => {
    expect(statusNextAction(rejected(), KEY)).toBe("key rejected — rotate it in Edit")
  })

  test("a state a clock fixes asks nothing of the operator", () => {
    expect(statusNextAction(account({ status: "cooling_down" }), KEY)).toBeNull()
    expect(statusNextAction(account(), KEY)).toBeNull()
  })
})

describe("credential pill on a dead login", () => {
  test("a stored token that no longer renews is not a green 'stored'", () => {
    const dead = account({ status: "needs_reauth", provider: "openai-oauth" })
    expect(credentialLabel(dead, OAUTH)).toBe("login lost")
    expect(credentialTone(dead, OAUTH)).toBe("warn")
  })

  test("a healthy stored credential still reads stored", () => {
    expect(credentialLabel(account(), KEY)).toBe("stored")
    expect(credentialTone(account(), KEY)).toBe("ok")
  })
})

describe("disableConsequences", () => {
  test("names a pool left with nothing to serve it", () => {
    const lines = disableConsequences(account({ id: "a" }), [
      pool("solo", [["a", "active"]]),
      pool("last-standing", [
        ["a", "active"],
        ["b", "disabled"],
      ]),
    ])
    expect(lines.join(" ")).toContain("solo, last-standing")
    expect(lines.join(" ")).toContain("refused")
  })

  test("says a pool with other members keeps serving", () => {
    const lines = disableConsequences(account({ id: "a" }), [
      pool("team", [
        ["a", "active"],
        ["b", "active"],
      ]),
    ])
    expect(lines.join(" ")).toContain("team")
    expect(lines.join(" ")).not.toContain("refused")
  })

  test("leaves out a pool this account is not in", () => {
    const lines = disableConsequences(account({ id: "a" }), [pool("other", [["b", "active"]])])
    expect(lines.join(" ")).not.toContain("other")
  })

  test("always says how to undo it", () => {
    expect(disableConsequences(account(), []).join(" ")).toContain("Enable")
  })
})
