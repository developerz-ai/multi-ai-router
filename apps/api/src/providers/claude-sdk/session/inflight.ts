/**
 * **One conversation, one turn at a time.** Which turn currently owns a session key, so a second
 * one arriving while it runs is served *detached* instead of colliding with it
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * The collision is not hypothetical and not rare. Coding-agent clients fire hidden one-shot
 * requests — a conversation title, a summary — carrying the **same** session header as the visible
 * turn, often in parallel with it. opencode does exactly this. Both requests then resolve to the
 * same SDK session, the second asks the CLI to resume a session the first is still running, and the
 * CLI refuses: `Session <id> is running as a background session`. Before this module that refusal
 * arrived as an `exit 1` on stderr, classified as a subprocess crash, answered `502`, and failed
 * over — restarting the user's conversation on a cold account mid-turn (production, 2026-09-06).
 *
 * **Detaching is the fix, and the busy-session fork is not.** Forking would answer the one-shot,
 * but the fork's new session id is what the turn then records against the conversation's key — so
 * a throwaway "write me a title" request would take ownership of the user's durable lineage and the
 * next real turn would resume from it. A hidden one-shot is not the conversation and must not
 * advance it. So a detached turn does two things and no more: it runs on a **fresh** SDK session,
 * and it **remembers nothing**.
 *
 * What it costs is exactly one cold prompt cache on a request the user never sees, which is the
 * cheapest thing in this whole design to spend.
 *
 * Properties worth stating because each one is a decision:
 *
 * - **Concurrency, not rate limiting.** A claim lives for one turn and is released the moment the
 *   subprocess is finished with. Sequential turns of a conversation — the normal case — never meet
 *   each other here and resume exactly as they always did.
 * - **Never a process singleton.** Per-runtime and per session key, like the quota store and the
 *   health store. A module-level map would let one runtime's turns detach another's inside a single
 *   process, and every test would start dirty.
 * - **Durable across replicas.** This is the fast local path; `./inflight-durable` wraps it with
 *   a Postgres advisory lease that fences a session claimed on another replica.
 *
 * The two gates are deliberately separate: `acquire` stays synchronous because
 * `SessionStore.resolve` and all of its callers are synchronous, while the durable lease is
 * awaited in `SessionTurn.prepare` before the CLI launch.
 */

import { scopedKey } from "./fingerprint"

/**
 * Why a claim was not granted. `local-busy` is the existing same-replica one-shot collision;
 * `durable-busy` means another replica owns the turn; `unavailable` means the durable lock itself
 * could not admit us (capacity, abort or shutdown), so running would be a silent cold start.
 */
export type SessionClaimRefusal = "local-busy" | "durable-busy" | "unavailable"

/** A held claim on one session key. Releasing twice is a no-op; releasing is never optional. */
export interface SessionClaim {
  /** False when another turn already owns the key — this turn must detach. */
  readonly held: boolean
  /** Set only when `held` is false: why this turn cannot own the conversation. */
  readonly refused?: SessionClaimRefusal
  release(): void
}

/** A durable lease on an advisory-lock key. `release` is async and idempotent. */
export interface SessionClaimLease {
  release(): Promise<void>
}

/**
 * The fleet-wide claim gate. Structural rather than tied to the db package so unit tests can
 * supply a two-instance fake; in production the SDK claim pool implements it. Keys are derived
 * with `advisoryLockKey` by the caller, so all replicas agree on them.
 */
export interface SessionClaimLock {
  tryAcquire(
    key: number,
    signal: AbortSignal,
  ): Promise<
    | { readonly acquired: true; readonly value: SessionClaimLease }
    | { readonly acquired: false; readonly reason: "busy" | "capacity" | "aborted" }
  >
}

export interface SessionClaims {
  /**
   * Take the key for one turn.
   *
   * @returns a claim whose `held` says whether it was granted. A refused claim still returns a
   * releasable value, so every caller can release unconditionally rather than branch on it.
   */
  acquire(key: string): SessionClaim
  /** How many keys are currently claimed. For tests and, one day, a gauge. */
  readonly size: number
}

/**
 * Derive the key space for a durable claim from the same scoped strings the local gate uses.
 * Account and SDK session id are both in scope: two accounts never contend on one session, and a
 * conversation and its SDK session cannot be claimed independently.
 */
export function sessionClaimKeys(key: string, accountId: string, sdkSessionId: string | null) {
  return {
    conversation: scopedKey("session", key),
    ...(sdkSessionId === null ? {} : { sdk: scopedKey("sdk", scopedKey(accountId, sdkSessionId)) }),
  }
}

/** Claims actual SDK sessions, never unrelated conversations sharing an opening fingerprint. */
export function claimSessionTurn(
  claims: SessionClaims,
  key: string,
  accountId: string,
  sdkSessionId: string | null,
): SessionClaim & {
  readonly keys: { conversation: string; sdk?: string }
  own(sdkSessionId: string): boolean
} {
  const keys = sessionClaimKeys(key, accountId, sdkSessionId)
  const direct = claims.acquire(keys.conversation)
  const sdkClaims = new Map<string, SessionClaim>()
  let released = false
  const own = (id: string): boolean => {
    if (released) return false
    const existing = sdkClaims.get(id)
    if (existing !== undefined) return existing.held
    const claim = claims.acquire(scopedKey("sdk", scopedKey(accountId, id)))
    sdkClaims.set(id, claim)
    return claim.held
  }
  const release = (): void => {
    if (released) return
    released = true
    direct.release()
    for (const claim of sdkClaims.values()) claim.release()
  }
  const sdkHeld = sdkSessionId === null || own(sdkSessionId)
  const held = direct.held && sdkHeld
  if (!held) release()
  return {
    held,
    ...(held ? {} : { refused: "local-busy" as const }),
    keys,
    own,
    release,
  }
}

const REFUSED: SessionClaim = { held: false, refused: "local-busy", release: () => {} }

export function createSessionClaims(): SessionClaims {
  const claimed = new Set<string>()

  return {
    acquire(key) {
      if (claimed.has(key)) return REFUSED
      claimed.add(key)
      let released = false
      return {
        held: true,
        release: () => {
          // Idempotent because it is called from two places that cannot coordinate: the turn's own
          // end inside the invoker, and the attempt's failure path. A second release must not free
          // a key some *later* turn has since claimed.
          if (released) return
          released = true
          claimed.delete(key)
        },
      }
    },
    get size() {
      return claimed.size
    },
  }
}
