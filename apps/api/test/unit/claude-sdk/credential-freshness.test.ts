import { describe, expect, test } from "bun:test"
import type { CredentialRefreshLease, CredentialRefreshLock } from "@multi-ai-router/db"
import {
  ALWAYS_FRESH,
  CLI_REFRESH_LEAD_MS,
  type CredentialFreshnessDeps,
  createCredentialFreshness,
} from "../../../src/providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import {
  CredentialMetadataOwnershipUnavailable,
  CredentialRefreshLeaseUnavailable,
} from "../../../src/providers/claude-sdk/ownership-errors"

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

/**
 * The credential file two replicas of the router read: one cell, one expiry instant. Sharing the
 * cell is what makes two gates "two replicas of one router" rather than "two unrelated accounts".
 */
interface CredentialCell {
  metadata: CredentialMetadata
}

interface Harness {
  readonly deps: CredentialFreshnessDeps
  /** A default cross-replica lease; tests that exercise a missing or broken lock override it. */
  readonly lock: Pick<CredentialRefreshLock, "tryAcquire">
  readonly lockState: { attempts: number; acquires: number; releases: number; holds: boolean }
  /** Advances the fake clock, which is also what a waiter's patience is measured against. */
  advance(ms: number): void
  setMetadata(next: CredentialMetadata): void
  readonly reads: () => number
  readonly warnings: () => readonly string[]
}

function harness(
  initial: CredentialMetadata,
  overrides: Partial<CredentialFreshnessDeps> = {},
  cell: CredentialCell = { metadata: initial },
): Harness {
  let clock = NOW_MS
  let reads = 0
  const warnings: string[] = []

  const defaultLock = fakeLock()
  const deps: CredentialFreshnessDeps = {
    reader: {
      read: async () => {
        reads += 1
        return cell.metadata
      },
    },
    refreshLock: defaultLock.lock,
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
    lock: defaultLock.lock,
    lockState: defaultLock.state,
    advance: (ms) => {
      clock += ms
    },
    setMetadata: (next) => {
      cell.metadata = next
    },
    reads: () => reads,
    warnings: () => warnings,
  }
}

const never = new AbortController().signal

/**
 * A controllable cross-replica lock fake: one lease at a time, with the counts a test can read.
 * Nothing here touches Postgres — it models exactly the `tryAcquire` surface the gate consumes.
 */
function fakeLock() {
  // `attempts` counts every request for the lease, granted or refused; `acquires` counts the
  // grants. The difference is what tells "never even reached the lock" from "reached it and was
  // refused" — the distinction between a local holder still standing and a takeover candidate.
  // Leases are per Account: one subscription's window never throttles another's in the pool.
  const state = { attempts: 0, acquires: 0, releases: 0, holds: false }
  const held = new Set<string>()
  const lock: Pick<CredentialRefreshLock, "tryAcquire"> = {
    tryAcquire: async (accountId) => {
      state.attempts += 1
      if (held.has(accountId)) return { acquired: false, reason: "busy" as const }
      held.add(accountId)
      state.holds = held.size > 0
      state.acquires += 1
      let released = false
      const lease: CredentialRefreshLease = {
        release: async () => {
          if (released) return
          released = true
          held.delete(accountId)
          state.holds = held.size > 0
          state.releases += 1
        },
      }
      return { acquired: true as const, lease }
    },
  }
  return { lock, state }
}

/** Drains pending microtasks without sleeping in real time. */
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * A sleep that only moves when the test steps it — one pending wait released per call. The fake
 * clock's sleep resolves instantly, which would run a waiter's whole patience cap inside one
 * microtask drain; ordering assertions need a waiter that stays parked until it is told to move.
 */
function stepSleep() {
  const pending: (() => void)[] = []
  return {
    sleep: (): Promise<void> => new Promise<void>((resolve) => pending.push(resolve)),
    step: (): void => pending.shift()?.(),
    parked: (): number => pending.length,
  }
}

describe("credential freshness", () => {
  test("a second caller inside the refresh window waits for the first — the double-spend regression", async () => {
    // Expiry is one minute out, well inside the 5-minute skew: the window is open.
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    const order: string[] = []

    // The winner is not delayed at all — it goes on to spawn, and refreshes as part of that.
    const winner = await gate.ensureFresh(ACCOUNT, never)
    order.push("winner")

    const loser = gate.ensureFresh(ACCOUNT, never).then(() => {
      order.push("loser")
    })

    // Nothing has refreshed the file yet, so the loser is still parked.
    await Promise.resolve()
    expect(order).toEqual(["winner"])

    // The winner's subprocess refreshes and exits its turn, releasing the lease. Only then can the
    // waiter re-admit on a re-won lease rather than a local-only claim.
    h.setMetadata(credential(8 * 3_600_000))
    winner.release()
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

  test("a winner that never refreshes refuses the waiter at the cap, and says so", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    const owner = await gate.ensureFresh(ACCOUNT, never)
    // The file never changes: the winner crashed, or the CLI did not refresh when expected.
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )

    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
    // No local-only claim was granted and the real owner's lease is untouched.
    owner.release()
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

  test("an unreadable credential file refuses the caller instead of bypassing the window", async () => {
    const h = harness(credential(60_000), {
      reader: {
        read: async () => {
          throw new Error("EACCES: permission denied")
        },
      },
    })
    const gate = createCredentialFreshness(h.deps)

    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialMetadataOwnershipUnavailable,
    )
    expect(h.warnings()).toEqual(["claude credential freshness ownership unavailable"])
  })

  test("a lock that reports busy or capacity grants no claim", async () => {
    for (const outcome of ["busy", "capacity"] as const) {
      const h = harness(credential(60_000))
      let granted = 0
      const gate = createCredentialFreshness({
        ...h.deps,
        refreshLock: {
          tryAcquire: async () => {
            granted += 1
            return { acquired: false as const, reason: outcome }
          },
        },
      })
      await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
        CredentialRefreshLeaseUnavailable,
      )
      // The lock was asked repeatedly but never granted one: no credential-file bypass.
      expect(granted).toBeGreaterThan(0)
    }
  })

  test("an aborted lease acquisition rejects with the caller's own reason", async () => {
    const h = harness(credential(60_000))
    const controller = new AbortController()
    const gate = createCredentialFreshness({
      ...h.deps,
      refreshLock: {
        tryAcquire: async () => {
          controller.abort(new Error("client went away"))
          return { acquired: false as const, reason: "aborted" as const }
        },
      },
    })
    await expect(gate.ensureFresh(ACCOUNT, controller.signal)).rejects.toThrow("client went away")
  })

  test("ownership expires, so a quiet Account does not arrive at its next window already blocked", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness(h.deps)

    await gate.ensureFresh(ACCOUNT, never)

    // Hours later the token is stale again. The local holder entry has aged out, but its lease was
    // never released: the lease is the authority, so a newcomer waits and then refuses rather than
    // becoming a second local owner of a window somebody else might still be refreshing.
    h.advance(8 * 3_600_000)
    h.setMetadata(credential(60_000))
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )

    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
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
 * The claim protocol: admission carries an exit, ownership is exclusive until that exit runs, and
 * every way a holder can die — release, abort, the wait cap, a lost lease — leaves the window in a
 * state the next caller can own. All driven off the fake clock and the lock fake; nothing here
 * sleeps in real time, spawns a CLI, or touches a live provider.
 */
describe("claims — every admission carries an exit", () => {
  test("a queued caller whose token crosses the boundary re-enters the window, one owner at a time", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const steps = stepSleep()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock, sleep: steps.sleep })

    const events: string[] = []
    const first = await gate.ensureFresh(ACCOUNT, never)
    events.push("first-owned")
    const second = gate.ensureFresh(ACCOUNT, never).then((claim) => {
      events.push("second-owned")
      return claim
    })
    const third = gate.ensureFresh(ACCOUNT, never).then((claim) => {
      events.push("third-owned")
      return claim
    })
    await drain()
    // Both arrivals re-classified, found the ACTIVE holder, and are parked in the wait — nobody
    // else owns the window while the first holder keeps its claim.
    expect(events).toEqual(["first-owned"])
    expect(state.acquires).toBe(1)

    // The holder's release is what frees the next owner — not the waiter's own patience. The
    // waiters wake on the release, re-classify, and exactly one of them wins the freed lease.
    first.release()
    const secondClaim = await second
    expect(events).toEqual(["first-owned", "second-owned"])
    expect(state.acquires).toBe(2)
    expect(state.releases).toBe(1)
    expect(state.holds).toBe(true)

    secondClaim.release()
    const thirdClaim = await third
    expect(events).toEqual(["first-owned", "second-owned", "third-owned"])
    expect(state.acquires).toBe(3)
    thirdClaim.release()
    expect(state.releases).toBe(3)
  })

  test("a refresh that lands while a caller is queued re-classifies it out of the window", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const steps = stepSleep()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock, sleep: steps.sleep })

    const owner = await gate.ensureFresh(ACCOUNT, never)
    const pending = gate.ensureFresh(ACCOUNT, never)
    await drain()
    // The arrival re-classified, found the ACTIVE holder, and is parked in the wait — and the
    // stepping sleep keeps it parked until the test moves it, so the exit below cannot be the
    // patience cap reached inside a microtask drain.
    expect(state.acquires).toBe(1)
    expect(steps.parked()).toBe(1)

    // The holder's subprocess refreshes mid-wait and exits its turn, releasing the lease. The file
    // reads fresh BEFORE the waiter's next poll is stepped, so it is the re-classification, not the
    // cap, that ends the wait — but only a re-won lease grants a claim.
    h.setMetadata(credential(8 * 3_600_000))
    owner.release()
    steps.step()
    const claim = await pending
    expect(state.holds).toBe(true)
    expect(h.warnings()).toEqual([])
    expect(state.acquires).toBe(2)
    expect(state.releases).toBe(1)
    claim.release()
  })

  test("of N concurrent admissions exactly one owns the open window, and the winner's release frees the next", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => gate.ensureFresh(ACCOUNT, never)),
    )
    const claims = results
      .filter(
        (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof gate.ensureFresh>>> =>
          result.status === "fulfilled",
      )
      .map((result) => result.value)
    // One owner; the other five waited behind the ACTIVE holder and refused at the cap — no second
    // lease was ever granted while the first holder kept its claim.
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(h.warnings()).toHaveLength(5)
    expect(new Set(h.warnings())).toEqual(
      new Set(["claude credential refresh did not land; refusing admission"]),
    )
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(5)
    for (const result of results) {
      if (result.status === "rejected") {
        expect(result.reason).toBeInstanceOf(CredentialRefreshLeaseUnavailable)
      }
    }
    expect(claims).toHaveLength(1)

    // Releasing the one claim frees the lease: the five refusals granted nothing.
    for (const claim of claims) claim.release()
    expect(state.releases).toBe(1)
    expect(state.holds).toBe(false)

    const next = await gate.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(2)
    next.release()
    expect(state.releases).toBe(2)
  })

  test("a capped waiter neither erases the unreleased holder nor admits a competing owner", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    const owner = await gate.ensureFresh(ACCOUNT, never)
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
    // The waiter granted no claim and left the holder's entry and lease exactly as they were.
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)

    // Now past the cap the holder is a takeover candidate — but the lease is still held, so the
    // newcomer waits like everyone else: no competing refresher is admitted.
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    owner.release()
    expect(state.holds).toBe(false)
    const fresh = await gate.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(2)
    fresh.release()
  })

  test("an interrupted owner's release lets the next caller own immediately, and release is idempotent", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    const controller = new AbortController()
    const owner = await gate.ensureFresh(ACCOUNT, controller.signal)
    // The turn dies before its exit runs, then the invoker's catch releases the claim.
    controller.abort(new Error("client went away"))
    owner.release()
    owner.release()
    expect(state.holds).toBe(false)
    expect(state.releases).toBe(1)

    // Owned on the first read, with zero poll ticks: the cap was never waited out.
    const reads = h.reads()
    const next = await gate.ensureFresh(ACCOUNT, never)
    expect(h.reads()).toBe(reads + 1)
    expect(state.acquires).toBe(2)
    next.release()
  })

  test("two gates sharing one lock never both own one account's window", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const gateA = createCredentialFreshness({ ...h.deps, refreshLock: lock })
    const gateB = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    const a = await gateA.ensureFresh(ACCOUNT, never)
    await expect(gateB.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
    a.release()
    expect(state.holds).toBe(false)

    const c = await gateB.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(2)
    c.release()
  })

  test("a waiter whose credential file goes unreadable mid-wait refuses admission", async () => {
    // The initial read succeeds (window open) and the in-loop re-read fails: the wait must end
    // fail-closed, never resolving with an undefined claim on exactly this path.
    let reads = 0
    const h = harness(credential(60_000), {
      reader: {
        read: async () => {
          reads += 1
          // Reads one and two are the owner's classify and the waiter's initial classify — both
          // succeed; the failure lands on the in-loop re-read, which is the path under test.
          if (reads <= 2) return credential(60_000)
          throw new Error("EIO: /data/claude/x/.credentials.json")
        },
      },
    })
    const gate = createCredentialFreshness(h.deps)

    const owner = await gate.ensureFresh(ACCOUNT, never)
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialMetadataOwnershipUnavailable,
    )
    expect(h.warnings()).toEqual(["claude credential freshness ownership unavailable"])
    owner.release()
  })

  test("an unavailable or failing lease refuses admission, never a local-entry claim", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness({
      ...h.deps,
      refreshLock: { tryAcquire: async () => ({ acquired: false, reason: "capacity" as const }) },
    })

    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
    // No local entry is left behind: every subsequent admission retries the lease and refuses.
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )

    // A lock that throws refuses the same way — no claim is granted.
    const h2 = harness(credential(60_000))
    const broken = createCredentialFreshness({
      ...h2.deps,
      refreshLock: {
        tryAcquire: async () => {
          throw new Error("lock pool drained")
        },
      },
    })
    await expect(broken.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    // A missing lock is just as unavailable as a broken one.
    const h3 = harness(credential(60_000), { refreshLock: undefined })
    const unwired = createCredentialFreshness(h3.deps)
    await expect(unwired.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
  })

  test("an aged-out owner whose release never ran keeps its lease authority, and a newcomer that cannot win it never becomes a second local owner", async () => {
    // The owner admitted into the window whose turn died before its exit ran never releases its
    // lease. Its local entry ages out, but the cross-replica lease is the authority: a newcomer
    // that cannot win it must never come back owning the same window on the local entry alone.
    const h = harness(credential(60_000))
    let attempts = 0
    const lock: Pick<CredentialRefreshLock, "tryAcquire"> = {
      tryAcquire: async () => {
        attempts += 1
        if (attempts === 1) {
          return { acquired: true as const, lease: { release: async () => {} } }
        }
        return { acquired: false as const, reason: "capacity" as const }
      },
    }
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    // The owner holds the lease; its turn dies here, so `release()` never runs.
    const owner = await gate.ensureFresh(ACCOUNT, never)
    expect(attempts).toBe(1)
    h.advance(20_100)

    // A newcomer asks for the same credential. It reaches the lease, is refused capacity, and has
    // no local-only fallback: it caps out and throws the fail-closed admission error.
    await expect(gate.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(attempts).toBeGreaterThan(1)
    expect(h.warnings()).toContain("claude credential refresh did not land; refusing admission")

    // The owner's own release is what frees the lease: only then can a new caller own the window.
    owner.release()
  })

  test("a lease lost to the caller's own abort rejects with that abort and rolls the admission back", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const controller = new AbortController()
    const reason = new Error("client went away")
    reason.name = "AbortError"
    let firstAcquire = true
    const gate = createCredentialFreshness({
      ...h.deps,
      refreshLock: {
        tryAcquire: async (accountId, signal) => {
          if (!firstAcquire) return lock.tryAcquire(accountId, signal)
          firstAcquire = false
          // The pool self-releases on the caller's abort and reports it: the signal is already
          // dead by the time the not-acquired result lands.
          controller.abort(reason)
          return { acquired: false, reason: "aborted" as const }
        },
      },
    })

    // The contract: rejection with the signal's own reason — never a claim for a caller that is
    // already gone, and never a local entry left standing behind one.
    await expect(gate.ensureFresh(ACCOUNT, controller.signal)).rejects.toBe(reason)
    expect(state.acquires).toBe(0)

    // The half-taken admission was rolled back: the next caller owns immediately — one read, no
    // wait, no warn, nothing left behind to cap out against.
    const reads = h.reads()
    const claim = await gate.ensureFresh(ACCOUNT, never)
    expect(h.reads()).toBe(reads + 1)
    expect(h.warnings()).toEqual([])
    claim.release()
    expect(state.releases).toBe(1)
    expect(state.holds).toBe(false)
  })
})

/**
 * The three races the claim protocol exists for, each driven through the **real** gate rather than
 * through a stub: a credential that crosses the CLI's refresh lead between two admissions, an
 * owner whose turn died before its exit ran, and two replicas of the router on one credential.
 *
 * Everything is injected — the reader returns instants, the clock is a counter, the lease is a
 * local fake. No `claude` CLI is spawned, no provider is called, no credential material exists
 * anywhere in this file, and no sleep takes real time.
 */
describe("the refresh window across the races that matter", () => {
  test("a credential that crosses the refresh lead between two admissions is re-admitted", async () => {
    // The credential is warm at the first admission and inside the CLI's own five-minute lead by
    // the second: the expiry instant never moves, the clock does. The gate must therefore admit
    // the second caller onto the window and onto the cross-replica lease — waving it through with
    // a no-op claim is what lets a second refresher spend the rotating token.
    const h = harness(credential(8 * 3_600_000))
    const { lock, state } = fakeLock()
    const steps = stepSleep()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock, sleep: steps.sleep })

    // Warm: eight hours of head-room against a five-minute skew. No window, no lease.
    const warm = await gate.ensureFresh(ACCOUNT, never)
    warm.release()
    expect(state.acquires).toBe(0)
    expect(h.warnings()).toEqual([])

    // The same expiry, now two minutes away — inside the CLI's refresh lead.
    h.advance(8 * 3_600_000 - 120_000)

    const owner = await gate.ensureFresh(ACCOUNT, never)
    // Re-admitted: this caller owns the window and holds the lease, so a refresher on another
    // replica is refused rather than double-spending the token.
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(h.warnings()).toEqual([])

    // A second arrival now finds the window owned and waits for it — it never even reaches the
    // cross-replica lock, because the local holder stands in the way first.
    const second = gate.ensureFresh(ACCOUNT, never)
    await drain()
    expect(state.attempts).toBe(1)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    // The owner ends its turn: the lease goes back and the window is handed over, not stranded.
    owner.release()
    steps.step()
    await drain()
    const next = await second
    expect(state.acquires).toBe(2)
    expect(state.holds).toBe(true)
    next.release()
    expect(state.releases).toBe(2)
  })

  test("an interrupted owner whose release never ran keeps its window and its lease", async () => {
    // The owner's turn dies before its exit runs: the signal aborts and `release()` is never
    // called. The entry it set stays, and the cross-replica lease it won stays held — a waiter
    // must neither erase that entry nor admit a competing owner while the stale entry ages out.
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const steps = stepSleep()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock, sleep: steps.sleep })

    const controller = new AbortController()
    const owner = await gate.ensureFresh(ACCOUNT, controller.signal)
    // The turn dies here: nothing calls `release()`, so the claim and its lease are still held.
    controller.abort(new Error("client went away"))
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    // A waiter arrives a moment later, while the interrupted owner is still inside its window. It
    // finds the holder locally and never reaches the cross-replica lock at all.
    h.advance(100)
    const waiter = gate.ensureFresh(ACCOUNT, never)
    void waiter.catch(() => undefined)
    await drain()
    expect(state.attempts).toBe(1)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    // The waiter exhausts its patience while the holder's entry is still the one on record — the
    // exact moment the historical bug erased it. It must fail closed and leave the holder's
    // entry and its lease exactly as they were: erasing one we do not own is the takeover race.
    h.advance(20_100)
    steps.step()
    await drain()
    await expect(waiter).rejects.toBeInstanceOf(CredentialRefreshLeaseUnavailable)
    expect(h.warnings()).toEqual(["claude credential refresh did not land; refusing admission"])
    expect(state.releases).toBe(0)
    expect(state.holds).toBe(true)
    expect(state.acquires).toBe(1)

    // The holder's entry has now aged out, so takeover is the only path left for anyone else — and
    // the lease is still held, so the takeover is refused and no competing refresher is admitted.
    const tookOver = false
    const takeover = gate.ensureFresh(ACCOUNT, never)
    void takeover.catch(() => undefined)
    await drain()
    // It reached the lock and was refused: it did not take the window, and it did not resolve as
    // an owner either — a lease somebody else holds means waiting, not proceeding.
    expect(state.attempts).toBe(2)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)
    expect(tookOver).toBe(false)
    // The refused takeover keeps waiting; it runs out of patience and fails closed, still without
    // ever owning the window.
    h.advance(20_000)
    steps.step()
    await drain()
    await expect(takeover).rejects.toBeInstanceOf(CredentialRefreshLeaseUnavailable)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)

    // The owner's own exit is what ends the window; only then may a new caller own it.
    owner.release()
    expect(state.releases).toBe(1)
    expect(state.holds).toBe(false)
    const next = await gate.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(2)
    next.release()
    expect(state.releases).toBe(2)
  })

  test("two router instances on one credential and one lock never both own its window", async () => {
    // Two replicas of the router: separate gates, separate readers, separate clocks, separate
    // holder maps — one credential file and one cross-replica lease. The second instance's own
    // holder map is empty, so the lease is the only thing that can stop it from becoming a second
    // refresher.
    const { lock, state } = fakeLock()
    const cell: CredentialCell = { metadata: credential(60_000) }
    const a = harness(cell.metadata, {}, cell)
    const b = harness(cell.metadata, {}, cell)
    const steps = stepSleep()
    const gateA = createCredentialFreshness({ ...a.deps, refreshLock: lock })
    const gateB = createCredentialFreshness({ ...b.deps, refreshLock: lock, sleep: steps.sleep })

    const ownerA = await gateA.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    // The other replica asks for the same credential and is refused the lease.
    const waiter = gateB.ensureFresh(ACCOUNT, never)
    void waiter.catch(() => undefined)
    await drain()
    expect(state.attempts).toBe(2)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(b.warnings()).toEqual([])

    // The first replica's turn ends and hands the lease back.
    ownerA.release()
    await drain()
    expect(state.holds).toBe(false)
    expect(state.releases).toBe(1)

    // Now the second replica may own: the window is free and the lease is free.
    steps.step()
    await drain()
    const ownerB = await waiter
    expect(state.acquires).toBe(2)
    expect(state.holds).toBe(true)

    ownerB.release()
    expect(state.releases).toBe(2)
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

  test("fails closed when the file cannot be read", async () => {
    const h = harness(credential(-1), {
      reader: {
        read: async () => {
          throw new Error("EIO: /data/claude/x/.credentials.json")
        },
      },
    })
    const gate = createCredentialFreshness(h.deps)
    await expect(gate.wouldRefresh(ACCOUNT)).rejects.toBeInstanceOf(
      CredentialMetadataOwnershipUnavailable,
    )
    expect(h.warnings()).toEqual(["claude credential freshness ownership unavailable"])
  })

  test("the no-op gate never calls a credential cold", async () => {
    expect(await ALWAYS_FRESH.wouldRefresh(ACCOUNT)).toBe(false)
  })
})
