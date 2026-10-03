import { expect, test } from "bun:test"
import { toRecoveryView } from "../../../src/services/accounts/recovery-view"

test("public recovery progress is an explicit projection with no private capability facts", () => {
  const row = {
    generation: "generation-fixture",
    state: "issued" as const,
    nextAllowedAt: new Date("2026-10-03T18:00:00Z"),
    outcomeAt: null,
    ownerBootId: "secret-boot",
    permitId: "secret-permit",
    credentialFingerprint: "secret-fingerprint",
    authMaterial: "secret-ciphertext",
    providerAccountId: "secret-provider-identity",
  }
  const view = toRecoveryView(row)
  expect(Object.keys(view).sort()).toEqual(["generation", "nextAllowedAt", "outcomeAt", "state"])
  const rendered = JSON.stringify(view)
  expect(view.state).toBe("issued")
  expect(view.outcomeAt).toBeNull()
  for (const privateFact of [
    "secret-boot",
    "secret-permit",
    "secret-fingerprint",
    "secret-ciphertext",
    "secret-provider-identity",
  ])
    expect(rendered).not.toContain(privateFact)
})
