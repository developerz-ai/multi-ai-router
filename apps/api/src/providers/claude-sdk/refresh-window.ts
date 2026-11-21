import type {
  CredentialRefreshLease,
  CredentialRefreshLeaseResult,
  CredentialRefreshLock,
} from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import { abortReason } from "./abort"
import type { CredentialRefreshClaim } from "./credential-freshness"
import { CredentialRefreshLeaseUnavailable } from "./ownership-errors"

/**
 * The holder record behind `credential-freshness.ts`: who is inside each Account's refresh window,
 * and who may take it. Split out of the gate by responsibility (101 finding 05.13) — the gate
 * decides *whether* a window is open and how long to wait; this decides *who owns it*. The record
 * is private to the closure: nothing outside can add, remove or mark a holder except through a
 * claim's own `release`, so the ownership rules below hold exactly as they did inline.
 */

export interface RefreshWindowDeps {
  readonly now: () => Date
  /** Ownership ages out on the waiter's own cap (`CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS`). */
  readonly maxWaitMs: number
  readonly refreshLock?: Pick<CredentialRefreshLock, "tryAcquire">
  readonly logger?: Logger
}

export interface RefreshWindow {
  /** An owning claim, or `null` when the caller must wait (see `tryOwn` below). */
  tryOwn(accountId: string, signal: AbortSignal): Promise<CredentialRefreshClaim | null>
  /**
   * Whether `held` is an owning claim of this gate, still ACTIVE, on `accountId`'s record, and
   * backed by a lease this gate still holds. A local entry alone is never enough.
   */
  stillOwns(accountId: string, held: CredentialRefreshClaim): boolean
  /** Resolves when any holder recorded for the Account now releases. */
  anyRelease(accountId: string): Promise<void>[]
  /**
   * Re-check the cross-replica lease on a poll path that already holds a local claim. Refuses when
   * a lease cannot be won afresh: the caller must not keep refreshing on the local entry alone.
   */
  /** `null` when the lease is still held elsewhere; the caller goes back to waiting. */
  recheckLease(accountId: string, signal: AbortSignal): Promise<CredentialRefreshClaim | null>
}

/**
 * A local holder entry: one admission into the refresh window, until its claim is released or it
 * ages past the cap.
 */
interface Holder {
  readonly since: number
  released: boolean
  readonly done: Promise<void>
  readonly release: () => void
  /** Attached by `bind` once the cross-replica lease is won; absent on every non-acquiring path. */
  lease?: CredentialRefreshLease
}

export function createRefreshWindow(deps: RefreshWindowDeps): RefreshWindow {
  // The holders recorded for an Account: everyone admitted into its refresh window and not yet
  // released. Usually one — a takeover records the newcomer beside the holder it displaced, so an
  // owner that was taken over from and never released stays on the record.
  const holders = new Map<string, Set<Holder>>()
  // The holder behind each owning claim this gate handed out, so a re-ask can recognise its own.
  const owners = new WeakMap<CredentialRefreshClaim, Holder>()

  /** An entry is ACTIVE — a real holder a newcomer must wait behind — until released or aged out. */
  const isActive = (entry: Holder): boolean =>
    !entry.released && deps.now().getTime() - entry.since < deps.maxWaitMs

  /** The holders recorded for an Account, in the order they were admitted. */
  const recordedHolders = (accountId: string): Holder[] => [...(holders.get(accountId) ?? [])]

  /**
   * Records this caller's local entry beside the holders already on record; `bind` attaches the
   * lease the claim releases, if one was won. The entry leaves the record when it is released —
   * never when another caller takes the window over, so an owner that was displaced and never
   * released stays recorded for as long as it may still be inside its refresh window.
   */
  const admit = (
    accountId: string,
  ): { readonly entry: Holder; readonly bind: (lease: CredentialRefreshLease) => void } => {
    let marked = false
    let wake = (): void => undefined
    const entry: Holder = {
      since: deps.now().getTime(),
      released: false,
      done: new Promise<void>((resolve) => {
        wake = resolve
      }),
      release: () => {
        if (marked) return
        marked = true
        entry.released = true
        // Retire this holder alone: whoever took the window over from it is recorded beside it,
        // and that holder's own release is what takes it off the record.
        const recorded = holders.get(accountId)
        if (recorded !== undefined) {
          recorded.delete(entry)
          if (recorded.size === 0) holders.delete(accountId)
        }
        wake()
        void entry.lease?.release().catch(() => undefined)
      },
    }
    const recorded = holders.get(accountId)
    if (recorded === undefined) holders.set(accountId, new Set([entry]))
    else recorded.add(entry)
    deps.logger?.info("claude credential refresh window entered", { accountId })
    return {
      entry,
      bind: (lease) => {
        if (entry.released) void lease.release().catch(() => undefined)
        else entry.lease = lease
      },
    }
  }

  /**
   * The cross-replica lease is the authority for a refresh window. There is no such thing as a
   * local-only admission: every acquiring path must win it, and every non-acquiring path releases
   * whatever it took. `onRefused` is what a caller that may wait does with a lease held by another
   * replica; a re-checking caller that already holds a claim passes no callback and refuses outright.
   *
   * Returns the lease for the caller to bind, `null` to wait, or throws the fail-closed refusal.
   */
  const acquireLease = async (
    accountId: string,
    signal: AbortSignal,
    onRefused?: () => void,
  ): Promise<CredentialRefreshLease | null> => {
    if (deps.refreshLock === undefined) {
      throw new CredentialRefreshLeaseUnavailable(
        `claude credential refresh lease unavailable: no lock wired for ${accountId}`,
      )
    }
    let lease: CredentialRefreshLeaseResult
    try {
      lease = await deps.refreshLock.tryAcquire(accountId, signal)
    } catch (error) {
      const wrapped = new CredentialRefreshLeaseUnavailable(
        `claude credential refresh lease unavailable: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
      // A caller that may wait backs off on any lock failure; a re-checker refuses.
      if (onRefused !== undefined) {
        deps.logger?.warn("claude credential refresh lease unavailable; waiting for owner", {
          accountId,
          reason: wrapped.message,
        })
        onRefused()
        return null
      }
      throw wrapped
    }
    if (lease.acquired) return lease.lease
    // Busy, capacity or aborted: none of them may grant a local claim.
    if (onRefused !== undefined) {
      if (signal.aborted) throw abortReason(signal, "the credential refresh wait was abandoned")
      onRefused()
      return null
    }
    if (signal.aborted) throw abortReason(signal, "the credential refresh wait was abandoned")
    throw new CredentialRefreshLeaseUnavailable(
      `claude credential refresh lease unavailable: ${lease.reason}`,
    )
  }

  /**
   * Takes ownership when no ACTIVE holder stands in the way. Resolves with the owning claim —
   * local entry plus the cross-replica lease — or `null` when the caller must wait: an ACTIVE
   * holder or a lease somebody else already holds. A lease that cannot be won while an unreleased
   * holder is still on the record also waits: the cap frees *ownership*, not the refresh already
   * in flight, so a second local owner would be the double-spend race itself.
   */
  const tryOwn = async (
    accountId: string,
    signal: AbortSignal,
  ): Promise<CredentialRefreshClaim | null> => {
    const recorded = holders.get(accountId)
    // A holder past the cap is not a holder: either the winner crashed, or — the ordinary case —
    // it refreshed long ago and nothing ever released it. Ownership expires on the same clock a
    // waiter gives up on, so a quiet Account never arrives at its next window already blocked.
    const active = recorded !== undefined && [...recorded].some((entry) => isActive(entry))
    if (active) return null
    // Every holder on the record that never released may still be inside its refresh window, even
    // one that aged out. Read before `admit` — it answers "is somebody else already inside", not
    // "is this entry on the record".
    const unreleased = recorded !== undefined && [...recorded].some((entry) => !entry.released)
    const { entry, bind } = admit(accountId)
    const claim: CredentialRefreshClaim = { release: entry.release }
    owners.set(claim, entry)
    // Every exit after `admit` that does not acquire the lease releases the local entry: a refusal
    // never leaves a local owner standing behind a lease that was never won. The `onRefused`
    // callback handles the busy/capacity wait case; thrown refusals are fail-closed, except when an
    // unreleased owner may still be inside its window (then the caller waits for its release).
    let lease: CredentialRefreshLease | null = null
    try {
      lease = await acquireLease(accountId, signal, entry.release)
    } catch (error) {
      if (error instanceof CredentialRefreshLeaseUnavailable && unreleased && !signal.aborted) {
        entry.release()
        return null
      }
      entry.release()
      throw error
    }
    if (lease === null) return null
    bind(lease)
    return claim
  }

  return {
    tryOwn,
    stillOwns: (accountId, held) => {
      const own = owners.get(held)
      // A holder entry is necessary but never sufficient: the lease is the authority for the
      // window, and a claim that never bound one is not an admission (#101 identity rule kept).
      return (
        own !== undefined &&
        isActive(own) &&
        holders.get(accountId)?.has(own) === true &&
        own.lease !== undefined
      )
    },
    anyRelease: (accountId) => recordedHolders(accountId).map((held) => held.done),
    recheckLease: async (accountId, signal) => tryOwn(accountId, signal),
  }
}
