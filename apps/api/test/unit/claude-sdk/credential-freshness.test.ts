import { describe, expect, test } from "bun:test"
import type { CredentialRefreshLease, CredentialRefreshLock } from "@multi-ai-router/db"
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

/**
 * The credential file two replicas of the router read: one cell, one expiry instant. Sharing the
 * cell is what makes two gates "two replicas of one router" rather than "two unrelated accounts".
 */
interface CredentialCell {
  metadata: CredentialMetadata
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
  cell: CredentialCell = { metadata: initial },
): Harness {
  let clock = NOW_MS
  let reads = 0
  const warnings: string[] = []

  const deps: CredentialFreshnessDeps = {
    reader: {
      read: async () => {
        reads += 1
        return cell.metadata
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
  const state = { attempts: 0, acquires: 0, releases: 0, holds: false }
  const lock: Pick<CredentialRefreshLock, "tryAcquire"> = {
    tryAcquire: async () => {
      state.attempts += 1
      if (state.holds) return { acquired: false, reason: "busy" as const }
      state.holds = true
      state.acquires += 1
      const lease: CredentialRefreshLease = {
        release: async () => {
          if (!state.holds) return
          state.holds = false
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
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    await gate.ensureFresh(ACCOUNT, never)
    const pending = gate.ensureFresh(ACCOUNT, never)
    await drain()
    expect(state.acquires).toBe(1)

    // The holder's subprocess refreshes mid-wait — the file now reads fresh.
    h.setMetadata(credential(8 * 3_600_000))
    const claim = await pending
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    // A window-closed claim owns nothing: its release is inert.
    claim.release()
    expect(state.releases).toBe(0)
  })

  test("of N concurrent admissions exactly one owns the open window, and the winner's release frees the next", async () => {
    const h = harness(credential(60_000))
    const { lock, state } = fakeLock()
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock })

    const claims = await Promise.all(
      Array.from({ length: 6 }, () => gate.ensureFresh(ACCOUNT, never)),
    )
    // One owner; the other five waited behind the ACTIVE holder and capped out — no second lease
    // was ever granted while the first holder kept its claim.
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(h.warnings()).toHaveLength(5)
    expect(new Set(h.warnings())).toEqual(
      new Set(["claude credential refresh did not land; proceeding anyway"]),
    )

    // Exactly one of the six claims is the owner: releasing all of them frees the lease once.
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
    await gate.ensureFresh(ACCOUNT, never)
    expect(h.warnings()).toEqual(["claude credential refresh did not land; proceeding anyway"])
    // The waiter proceeded fail-open and left the holder's entry and lease exactly as they were.
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)

    // Now past the cap the holder is a takeover candidate — but the lease is still held, so the
    // newcomer waits like everyone else: no competing refresher is admitted.
    await gate.ensureFresh(ACCOUNT, never)
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
    await gateB.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(h.warnings()).toEqual(["claude credential refresh did not land; proceeding anyway"])
    a.release()
    expect(state.holds).toBe(false)

    const c = await gateB.ensureFresh(ACCOUNT, never)
    expect(state.acquires).toBe(2)
    c.release()
  })

  test("a waiter whose credential file goes unreadable mid-wait proceeds with a no-op claim", async () => {
    // The initial read succeeds (window open) and the in-loop re-read fails: the wait must end
    // fail-open with a no-op claim, never a crash — the regression this pins had the waiter
    // resolve with an undefined claim on exactly this path.
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

    await gate.ensureFresh(ACCOUNT, never)
    const claim = await gate.ensureFresh(ACCOUNT, never)
    expect(h.warnings()).toEqual([])
    claim.release()
  })

  test("an unavailable or failing lease degrades fail-open with a warn, on the local entry alone", async () => {
    const h = harness(credential(60_000))
    const gate = createCredentialFreshness({
      ...h.deps,
      refreshLock: { tryAcquire: async () => ({ acquired: false, reason: "capacity" as const }) },
    })

    const claim = await gate.ensureFresh(ACCOUNT, never)
    expect(h.warnings()).toEqual([
      "claude credential refresh lease unavailable; proceeding on the local entry",
    ])
    // The local entry still serializes this replica: the second arrival waits, then caps out.
    await gate.ensureFresh(ACCOUNT, never)
    expect(h.warnings()).toEqual([
      "claude credential refresh lease unavailable; proceeding on the local entry",
      "claude credential refresh did not land; proceeding anyway",
    ])
    claim.release()
    const next = await gate.ensureFresh(ACCOUNT, never)
    // Every admission retries the lease and degrades again — visible each time, never silent.
    expect(h.warnings()).toEqual([
      "claude credential refresh lease unavailable; proceeding on the local entry",
      "claude credential refresh did not land; proceeding anyway",
      "claude credential refresh lease unavailable; proceeding on the local entry",
    ])
    next.release()

    // A lock that throws degrades the same way — never a rejected spawn.
    const h2 = harness(credential(60_000))
    const broken = createCredentialFreshness({
      ...h2.deps,
      refreshLock: {
        tryAcquire: async () => {
          throw new Error("lock pool drained")
        },
      },
    })
    const still = await broken.ensureFresh(ACCOUNT, never)
    expect(h2.warnings()).toEqual([
      "claude credential refresh lease unavailable; proceeding on the local entry",
    ])
    still.release()
  })

  test("an aged-out owner whose release never ran keeps its entry recorded, and a newcomer that cannot win the lease does not become a second local owner", async () => {
    // The takeover case, and the defect it hides: an owner admitted into the window whose turn
    // died before its exit ran never releases, so its entry ages out while the owner may still be
    // inside its refresh window. A newcomer is then admitted — and if the lease cannot be won, it
    // must NOT come back owning the same window on the local entry alone, and it must not erase
    // the aged-out owner's record. Both halves are observable: the newcomer is refused (it waits,
    // as a busy lease refuses it), and the aged-out owner's entry stays on the record, so a later
    // caller is refused too.
    const h = harness(credential(60_000))
    const steps = stepSleep()
    // The first admission wins the lease; every later attempt is refused with "capacity" — the
    // pool could not give out a session, so the cross-replica lock cannot vouch for the window.
    let attempts = 0
    const lock: Pick<CredentialRefreshLock, "tryAcquire"> = {
      tryAcquire: async () => {
        attempts += 1
        if (attempts === 1) {
          return {
            acquired: true as const,
            lease: { release: async () => {} },
          }
        }
        return { acquired: false as const, reason: "capacity" as const }
      },
    }
    const gate = createCredentialFreshness({ ...h.deps, refreshLock: lock, sleep: steps.sleep })

    // The owner is admitted and holds the window. Its turn dies here: `release()` never runs.
    const owner = await gate.ensureFresh(ACCOUNT, never)
    expect(attempts).toBe(1)

    // The entry ages out past the cap: ownership expires, but the owner may still be refreshing.
    h.advance(20_100)

    // A newcomer arrives and the lease cannot be won. It must wait behind the aged-out owner
    // rather than take the window on the local entry alone — two local owners of one credential
    // is the double-spend race itself. The refusal shows as a parked waiter: an owner claim
    // resolves straight away, a refused one waits for the cap.
    let settled = false
    const newcomer = gate.ensureFresh(ACCOUNT, never).then((claim) => {
      settled = true
      return claim
    })
    await drain()
    expect(attempts).toBe(2)
    expect(settled).toBe(false)

    // The waiter's patience runs out: it proceeds fail-open with a no-op claim, exactly as any
    // other waiter does. It never owned the window — the no-op claim releases nothing.
    h.advance(20_000)
    steps.step()
    await drain()
    const waited = await newcomer
    expect(settled).toBe(true)
    expect(h.warnings()).toEqual(["claude credential refresh did not land; proceeding anyway"])
    waited.release()

    // The aged-out owner's entry is still on record — the refused takeover did not erase it. A
    // later caller whose lease also cannot be won is therefore refused too, instead of being let
    // through as a local owner of a window the aged-out owner may still be inside. Erase the
    // entry and this caller owns the window outright: the second local owner.
    let laterSettled = false
    const later = gate.ensureFresh(ACCOUNT, never).then((claim) => {
      laterSettled = true
      return claim
    })
    await drain()
    expect(attempts).toBe(3)
    expect(laterSettled).toBe(false)
    h.advance(20_000)
    steps.step()
    await drain()
    const laterWaited = await later
    expect(h.warnings()).toEqual([
      "claude credential refresh did not land; proceeding anyway",
      "claude credential refresh did not land; proceeding anyway",
    ])
    laterWaited.release()

    // The aged-out owner's own release is what ends the window: the next caller owns it outright,
    // with no wait.
    owner.release()
    const reads = h.reads()
    const next = await gate.ensureFresh(ACCOUNT, never)
    expect(h.reads()).toBe(reads + 1)
    expect(attempts).toBe(4)
    next.release()
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
    await drain()
    expect(state.attempts).toBe(1)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)

    // The waiter exhausts its patience while the holder's entry is still the one on record — the
    // exact moment the historical bug erased it. It must proceed fail-open and leave the holder's
    // entry and its lease exactly as they were: erasing one we do not own is the takeover race.
    h.advance(20_100)
    steps.step()
    await drain()
    const claim = await waiter
    expect(h.warnings()).toEqual(["claude credential refresh did not land; proceeding anyway"])
    expect(state.releases).toBe(0)
    expect(state.holds).toBe(true)
    expect(state.acquires).toBe(1)
    claim.release()

    // The holder's entry has now aged out, so takeover is the only path left for anyone else — and
    // the lease is still held, so the takeover is refused and no competing refresher is admitted.
    let tookOver = false
    const takeover = gate.ensureFresh(ACCOUNT, never).then((c) => {
      tookOver = true
      return c
    })
    await drain()
    // It reached the lock and was refused: it did not take the window, and it did not resolve as
    // an owner either — a lease somebody else holds means waiting, not proceeding.
    expect(state.attempts).toBe(2)
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)
    expect(tookOver).toBe(false)
    // The refused takeover keeps waiting; it runs out of patience and proceeds fail-open, still
    // without ever owning the window.
    h.advance(20_000)
    steps.step()
    await drain()
    const waited = await takeover
    expect(state.acquires).toBe(1)
    expect(state.holds).toBe(true)
    expect(state.releases).toBe(0)
    waited.release()

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
    let owned = false
    const waiter = gateB.ensureFresh(ACCOUNT, never).then((claim) => {
      owned = true
      return claim
    })
    await drain()
    expect(owned).toBe(false)
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
    expect(owned).toBe(true)
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
