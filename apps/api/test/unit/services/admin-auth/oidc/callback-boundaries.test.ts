import { describe, expect, test } from "bun:test"
import { AdminAuthError } from "@multi-ai-router/core"
import { createOIDCFlow } from "../../../../../src/services/admin-auth/oidc/flow"
import { createOIDCStateStore } from "../../../../../src/services/admin-auth/oidc/state"
import { createCredentialCipher } from "../../../../../src/services/crypto/cipher"
import { createMemoryStore } from "../../../../support/memory-store"

function fixture() {
  const store = createMemoryStore()
  let nowMs = 1_700_000_000_000
  let fetches = 0
  const stateDeps = {
    states: store.oauthStates,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    stateMinutes: 10,
    now: () => new Date(nowMs),
  }
  return {
    states: createOIDCStateStore(stateDeps),
    expire: () => {
      nowMs += 600_001
    },
    fetches: () => fetches,
    // Every instance starts with cold discovery, as after a process restart.
    coldFlow: () =>
      createOIDCFlow({
        config: {
          issuerUrl: "https://sso.test",
          clientId: "router",
          clientSecret: null,
          redirectUri: "https://router.test/api/admin/auth/oidc/callback",
          adminEmails: ["admin@test"],
          scopes: ["openid"],
        },
        stateStore: stateDeps,
        now: stateDeps.now,
        fetch: async () => {
          fetches += 1
          return new Response(null, { status: 503 })
        },
      }),
  }
}

describe("OIDC callbacks reject unusable state before contacting the IdP", () => {
  for (const condition of ["unknown", "expired", "consumed"] as const) {
    test(`${condition} state does not trigger cold discovery`, async () => {
      const h = fixture()
      const { state } = await h.states.issue()
      if (condition === "expired") h.expire()
      if (condition === "consumed") await h.states.consume(state)

      await expect(
        h
          .coldFlow()
          .complete({ code: "unused", state: condition === "unknown" ? "unknown" : state }),
      ).rejects.toBeInstanceOf(AdminAuthError)
      expect(h.fetches()).toBe(0)
    })
  }

  test("a failed discovery still consumes valid state, so replay makes no request", async () => {
    const h = fixture()
    const { state } = await h.states.issue()
    await expect(h.coldFlow().complete({ code: "unused", state })).rejects.toBeInstanceOf(
      AdminAuthError,
    )
    expect(h.fetches()).toBe(1)
    await expect(h.coldFlow().complete({ code: "unused", state })).rejects.toBeInstanceOf(
      AdminAuthError,
    )
    expect(h.fetches()).toBe(1)
  })
})
