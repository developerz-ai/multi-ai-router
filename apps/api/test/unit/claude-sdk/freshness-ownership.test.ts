import { expect, test } from "bun:test"
import { createCredentialFreshness } from "../../../src/providers/claude-sdk/credential-freshness"
import { CredentialMetadataOwnershipUnavailable } from "../../../src/providers/claude-sdk/ownership-errors"

for (const phase of ["cold-check", "initial", "waiter"] as const) {
  test(`credential ownership refusal fails closed during ${phase}`, async () => {
    let reads = 0
    let deny = phase !== "waiter"
    const gate = createCredentialFreshness({
      reader: {
        read: async () => {
          reads++
          if (deny) throw new CredentialMetadataOwnershipUnavailable()
          return {
            hasTokens: true,
            accessTokenExpiresAt: new Date(1000),
            refreshTokenExpiresAt: null,
            subscriptionType: null,
            rateLimitTier: null,
          }
        },
      },
      configDirs: { pathFor: (id) => `/offline/${id}` },
      now: () => new Date(0),
      skewMs: 300000,
      coldMarginMs: 300000,
      maxWaitMs: 1000,
      pollMs: 10,
      sleep: async () => {
        deny = true
      },
    })
    const signal = new AbortController().signal
    if (phase === "waiter") await gate.ensureFresh("account", signal)
    await expect(
      phase === "cold-check" ? gate.wouldRefresh("account") : gate.ensureFresh("account", signal),
    ).rejects.toBeInstanceOf(CredentialMetadataOwnershipUnavailable)
    expect(reads).toBe(phase === "waiter" ? 3 : 1)
  })
}
