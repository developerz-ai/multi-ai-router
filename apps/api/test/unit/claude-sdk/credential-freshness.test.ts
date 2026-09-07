import { describe, expect, test } from "bun:test"
import {
  ALWAYS_FRESH,
  CLI_REFRESH_LEAD_MS,
  type CredentialFreshnessDeps,
  createCredentialFreshness,
} from "../../../src/providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"

/**
 * The gate that stops two `claude` subprocesses from spending one rotating refresh token.
 *
 * The regression it exists for is the 2026-09-06 incident: three of six production Accounts were
 * deauthenticated when a second subprocess crossed the refresh moment, got its double-spend
 * rejected, and blanked a credential whose refresh token still had a month to run. The first test
 * below is that failure — two callers inside the window, and only one may go on to spawn.
 *
 * Pure logic with everything injected: no disk, no clock, no sleeping in real time. Nothing here is,
 * or resembles, a real credential — the reader is a stub returning instants.
 */

const ACCOUNT = "8e0d3f4a-0000-4000-8000-00000000abcd"
const NOW_MS = 1_788_000_000_000

/** A credential whose access token dies `inMs` from `NOW_MS`. Tokens present, nothing token-shaped. */
function credential(inMs: number | null, hasTokens = true): CredentialMetadata {
  return {
    refreshTokenExpiresAt: new Date(NOW_MS + 30 * 24 * 3_600_000),
    accessTokenExpiresAt: inMs === null ? null : new Date(NOW_MS + inMs),
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    hasTokens,
  }
}

interface Harness {
  readonly deps: CredentialFreshnessDeps
  /** Advances the fake clock, which is also what a waiter's patience is measured against. */
  advance(ms: number): void
  setMetadata(next: CredentialMetadata): void
  readonly reads: () => number
  readonly warnings: () => readonly string[]
}

function harness(
  initial: CredentialMetadata,
  overrides: Partial<CredentialFreshnessDeps> = {},
): Harness {
  let clock = NOW_MS
  let metadata = initial
  let reads = 0
  const warnings: string[] = []

  const deps: CredentialFreshnessDeps = {
    reader: {
      read: async () => {
        reads += 1
        return metadata
      },
    },
    configDirs: { pathFor: (id: string) => `/data/claude/${id}` },
    skewMs: 300_000,
    coldMarginMs: 600_000,
    maxWaitMs: 20_000,
    pollMs: 250,
    now: () => new Date(clock),
    // Every "sleep" is an instant tick of the fake clock, so the patience cap is reached in
    // deterministic steps rather than wall time.
    sleep: async (ms) => {
      clock += ms
    },
    logger: {
      warn: (message: string) => warnings.push(message),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as CredentialFreshnessDeps["logger"],
    ...overrides,
  }

  return {
    deps,
    advance: (ms) => {
      clock += ms
    },
    setMetadata: (next) => {
      metadata = next
    },
    reads: () => reads,
    warnings: () => warnings,
  }
}

const never = new AbortController().signal

describe("credential freshness", () => {
  test("a second caller inside the refresh window waits for the first — the double-spend regression", async () => {
    // Expiry is one minute out, well inside the 5-minute skew: the window is open.
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    const order: string[] = []

    // The winner is not delayed at all — it goes on to spawn, and refreshes as part of that.
    await gate.ensureFresh(ACCOUNT, never)
    order.push("winner")

    const loser = gate.ensureFresh(ACCOUNT, never).then(() => {
      order.push("loser")
    })

    // Nothing has refreshed the file yet, so the loser is still parked.
    await Promise.resolve()
    expect(order).toEqual(["winner"])

    // The winner's subprocess refreshes: the file now carries a token eight hours out.
    h.setMetadata(credential(8 * 3_600_000))
    await loser

    expect(order).toEqual(["winner", "loser"])
    expect(h.warnings()).toEqual([])
  })

  test("a fresh access token costs one read and no wait", async () => {
    const h = harness(credential(8 * 3_600_000))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)
    await gate.ensureFresh(ACCOUNT, never)

    // Two reads, zero polling: the common path adds a metadata read and nothing else.
    expect(h.reads()).toBe(2)
    expect(h.warnings()).toEqual([])
  })

  test("a winner that never refreshes releases the waiter at the cap, and says so", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)
    // The file never changes: the winner crashed, or the CLI did not refresh when expected.
    await gate.ensureFresh(ACCOUNT, never)

    expect(h.warnings()).toEqual(["claude credential refresh did not land; proceeding anyway"])
  })

  test("a blanked credential is let straight through — parking it is routing's job, not this gate's", async () => {
    const h = harness(credential(60_000, false))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)
    await gate.ensureFresh(ACCOUNT, never)

    // No waiting: an Account with no usable login must reach its error, not sit behind a refresh.
    expect(h.reads()).toBe(2)
    expect(h.warnings()).toEqual([])
  })

  test("an unknown expiry is treated as fresh rather than routing every request through the slow path", async () => {
    const h = harness(credential(null))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)
    await gate.ensureFresh(ACCOUNT, never)

    expect(h.reads()).toBe(2)
  })

  test("an unreadable credential file never blocks a caller", async () => {
    const h = harness(credential(60_000), {
      reader: {
        read: async () => {
          throw new Error("EACCES: permission denied")
        },
      },
    })
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)

    expect(h.warnings()).toEqual(["claude credential freshness unreadable"])
  })

  test("ownership expires, so a quiet Account does not arrive at its next window already blocked", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)

    // Hours later the token is stale again and nobody is actually inside. The next caller must
    // take ownership immediately rather than waiting out the cap behind a ghost.
    h.advance(8 * 3_600_000)
    h.setMetadata(credential(60_000))
    await gate.ensureFresh(ACCOUNT, never)

    expect(h.warnings()).toEqual([])
  })

  test("a waiter abandoned by its caller rejects with the caller's own reason", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)
    await gate.ensureFresh(ACCOUNT, never)

    const controller = new AbortController()
    const reason = new Error("client went away")
    reason.name = "AbortError"
    controller.abort(reason)

    expect(gate.ensureFresh(ACCOUNT, controller.signal)).rejects.toThrow("client went away")
  })

  test("two Accounts never wait on each other", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)
    // A different Account's window is its own: pooling means many Accounts of one Provider, and one
    // subscription's refresh must not stall the pool.
    await gate.ensureFresh("11111111-0000-4000-8000-00000000beef", never)

    expect(h.warnings()).toEqual([])
  })
})

/**
 * The rule the 2026-09-07 evidence settled on: a subprocess that will be ended early must never be
 * the one that refreshes. `wouldRefresh` is what every turn-free spawn asks first, and it must say
 * `true` for the whole stretch in which the CLI would refresh on its own — the CLI's five-minute
 * lead, plus the router's margin on top — and `false` wherever nothing could be rotated.
 */
describe("wouldRefresh — whether a spawn now would rotate the refresh token", () => {
  test("pins the CLI's own lead: five minutes, as CLI 2.1.261's qO() has it", () => {
    expect(CLI_REFRESH_LEAD_MS).toBe(300_000)
  })

  test("is true inside the cold margin, at expiry, and past it", async () => {
    for (const inMs of [599_000, 300_000, 1, 0, -3_600_000]) {
      const gate = createCredentialFreshness(harness(credential(inMs)).deps)
      expect(await gate.wouldRefresh(ACCOUNT)).toBe(true)
    }
  })

  test("is false with the margin to spare — the common case, and it must stay free", async () => {
    const h = harness(credential(601_000))
    const gate = createCredentialFreshness(h.deps)
    expect(await gate.wouldRefresh(ACCOUNT)).toBe(false)
    expect(h.reads()).toBe(1)
  })

  test("is false when there is no token to rotate", async () => {
    const gate = createCredentialFreshness(harness(credential(-1, false)).deps)
    expect(await gate.wouldRefresh(ACCOUNT)).toBe(false)
  })

  test("is false on an unknown expiry — the CLI would not refresh on unknown either", async () => {
    const gate = createCredentialFreshness(harness(credential(null)).deps)
    expect(await gate.wouldRefresh(ACCOUNT)).toBe(false)
  })

  test("is false, and says so, when the file cannot be read", async () => {
    const h = harness(credential(-1), {
      reader: {
        read: async () => {
          throw new Error("EIO: /data/claude/x/.credentials.json")
        },
      },
    })
    const gate = createCredentialFreshness(h.deps)
    expect(await gate.wouldRefresh(ACCOUNT)).toBe(false)
    expect(h.warnings()).toEqual(["claude credential freshness unreadable"])
  })

  test("the no-op gate never calls a credential cold", async () => {
    expect(await ALWAYS_FRESH.wouldRefresh(ACCOUNT)).toBe(false)
  })
})
