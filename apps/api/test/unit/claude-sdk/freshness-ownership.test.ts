import { expect, test } from "bun:test"
import { createCredentialFreshness } from "../../../src/providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import {
  CredentialMetadataOwnershipUnavailable,
  CredentialRefreshLeaseUnavailable,
} from "../../../src/providers/claude-sdk/ownership-errors"

const ACCOUNT = "account"
const FRESH: CredentialMetadata = {
  hasTokens: true,
  accessTokenExpiresAt: new Date(1000),
  refreshTokenExpiresAt: null,
  subscriptionType: null,
  rateLimitTier: null,
}

/** A lease that grants once and then stays held, so a second admission must wait. */
function oneLease() {
  let held = false
  let claims = 0
  return {
    get claims() {
      return claims
    },
    lock: {
      tryAcquire: async () => {
        if (held) return { acquired: false as const, reason: "busy" as const }
        held = true
        claims += 1
        return { acquired: true as const, lease: { release: async () => {} } }
      },
    },
  }
}

/** Clock that advances on every read, so a waiter reaches its cap without real-time sleeps. */
const steppingClock = () => {
  let time = 0
  return () => {
    time += 600
    return new Date(time)
  }
}

const base = {
  configDirs: { pathFor: (id: string) => `/offline/${id}` },
  now: steppingClock(),
  skewMs: 300000,
  coldMarginMs: 300000,
  maxWaitMs: 1000,
  pollMs: 10,
  sleep: async () => {},
}

/**
 * Ownership refusal is fail-closed on every path that classifies or leases a refresh window. Each
 * case asserts the specific error type, not just a rejection: the guardian-unavailable and
 * lease-unavailable errors must stay distinguishable for the dataplane's admission-refused mapping.
 */
test("cold-check refuses with the guardian-unavailable error", async () => {
  const gate = createCredentialFreshness({
    ...base,
    reader: {
      read: async () => {
        throw new CredentialMetadataOwnershipUnavailable()
      },
    },
  })
  await expect(gate.wouldRefresh(ACCOUNT)).rejects.toBeInstanceOf(
    CredentialMetadataOwnershipUnavailable,
  )
})

test("initial classify refuses with the guardian-unavailable error", async () => {
  const lease = oneLease()
  const gate = createCredentialFreshness({
    ...base,
    reader: {
      read: async () => {
        throw new CredentialMetadataOwnershipUnavailable()
      },
    },
    refreshLock: lease.lock,
  })
  await expect(gate.ensureFresh(ACCOUNT, new AbortController().signal)).rejects.toBeInstanceOf(
    CredentialMetadataOwnershipUnavailable,
  )
  expect(lease.claims).toBe(0)
})

test("a waiter whose poll read fails refuses with the guardian error and grants no claim", async () => {
  const lease = oneLease()
  let reads = 0
  const gate = createCredentialFreshness({
    ...base,
    reader: {
      read: async () => {
        reads += 1
        if (reads > 1) throw new CredentialMetadataOwnershipUnavailable()
        return FRESH
      },
    },
    refreshLock: lease.lock,
  })
  const owner = await gate.ensureFresh(ACCOUNT, new AbortController().signal)
  await expect(gate.ensureFresh(ACCOUNT, new AbortController().signal)).rejects.toBeInstanceOf(
    CredentialMetadataOwnershipUnavailable,
  )
  expect(lease.claims).toBe(1)
  owner.release()
})

test("no lock wired, a thrown lock, busy and capacity all refuse with the lease error", async () => {
  const unwired = createCredentialFreshness({ ...base, reader: { read: async () => FRESH } })
  await expect(unwired.ensureFresh(ACCOUNT, new AbortController().signal)).rejects.toBeInstanceOf(
    CredentialRefreshLeaseUnavailable,
  )

  for (const outcome of ["busy", "capacity"] as const) {
    const gate = createCredentialFreshness({
      ...base,
      reader: { read: async () => FRESH },
      refreshLock: { tryAcquire: async () => ({ acquired: false as const, reason: outcome }) },
    })
    await expect(gate.ensureFresh(ACCOUNT, new AbortController().signal)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
  }

  const throwing = createCredentialFreshness({
    ...base,
    reader: { read: async () => FRESH },
    refreshLock: {
      tryAcquire: async () => {
        throw new Error("lock backend unavailable")
      },
    },
  })
  await expect(throwing.ensureFresh(ACCOUNT, new AbortController().signal)).rejects.toBeInstanceOf(
    CredentialRefreshLeaseUnavailable,
  )
})

test("an aborted lease acquisition rejects with the caller's own abort", async () => {
  const controller = new AbortController()
  const gate = createCredentialFreshness({
    ...base,
    reader: { read: async () => FRESH },
    refreshLock: {
      tryAcquire: async () => {
        controller.abort(new Error("client went away"))
        return { acquired: false as const, reason: "aborted" as const }
      },
    },
  })
  await expect(gate.ensureFresh(ACCOUNT, controller.signal)).rejects.toThrow("client went away")
})

test("the lease refusal is an admission refusal, not an unownable guardian", async () => {
  const gate = createCredentialFreshness({ ...base, reader: { read: async () => FRESH } })
  let refused: unknown
  try {
    await gate.ensureFresh(ACCOUNT, new AbortController().signal)
  } catch (error) {
    refused = error
  }
  expect(refused).toBeInstanceOf(CredentialRefreshLeaseUnavailable)
  expect(refused).not.toBeInstanceOf(CredentialMetadataOwnershipUnavailable)
})
