/**
 * The fleet-wide half of the session claim: a Postgres advisory lease around the synchronous
 * local gate in `./inflight` (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * The local gate stays synchronous because `SessionStore.resolve` is on the request path. This
 * module's lease is awaited in `SessionTurn.prepare`, before any CLI launch. A session claimed on
 * another replica is refused (`durable-busy`), as is a lock outage (`unavailable`); neither ever
 * degrades into a quiet cold start.
 */

import {
  claimSessionTurn,
  type SessionClaim,
  type SessionClaimLease,
  type SessionClaimLock,
  type SessionClaimRefusal,
  type SessionClaims,
} from "./inflight"

/**
 * A claim that is good locally but whose durable lease has not been taken yet. Returned by
 * {@link claimSessionTurnDurable}; the caller awaits `prepare()` before launching the CLI, and a
 * refusal here is a `session-busy` plan plus a log line, never a quiet fresh resume.
 */
export interface DurableSessionClaim extends SessionClaim {
  readonly keys: { conversation: string; sdk?: string }
  /** All local claims this turn holds, for the record path. */
  readonly own: (sdkSessionId: string) => boolean
  /** Take the fleet-wide lease. Idempotent; later calls return the first result. */
  prepare(signal?: AbortSignal): Promise<boolean>
  /** Release local claims at once and schedule the durable lease release. Idempotent. */
  release(): void
}

/**
 * Wrap a local claim with a durable advisory lease. The local `held` gate runs first: a
 * same-replica one-shot never touches Postgres. When the durable gate is absent the local verdict
 * stands unchanged, so existing callers and unit tests need no lock.
 *
 * A refusal is recorded on `refused` and surfaced to the caller through the existing
 * `session-busy` plan. Nothing here starts a fresh session silently: the caller sees `held: false`
 * and must report it.
 */
export function claimSessionTurnDurable(
  claims: SessionClaims,
  key: string,
  accountId: string,
  sdkSessionId: string | null,
  lock?: SessionClaimLock,
): DurableSessionClaim {
  const claim = claimSessionTurn(claims, key, accountId, sdkSessionId)
  let durable: SessionClaimLease | undefined
  let preparing: Promise<boolean> | undefined
  let prepared = false
  let released = false
  let refused: SessionClaimRefusal | undefined = claim.refused

  const prepare = (signal?: AbortSignal): Promise<boolean> => {
    if (!claim.held) return Promise.resolve(false)
    if (refused !== undefined) return Promise.resolve(false)
    if (prepared) return Promise.resolve(true)
    preparing ??= (async () => {
      if (lock === undefined) return true
      const controller = new AbortController()
      const onAbort = () => controller.abort(signal?.reason)
      signal?.addEventListener("abort", onAbort, { once: true })
      // An already-aborted signal fired before the listener existed; honor it here.
      if (signal?.aborted) controller.abort(signal.reason)
      try {
        // The conversation key is the turn mutex; the SDK key additionally fences a resume.
        const conversation = await lock.tryAcquire(
          advisoryId(claim.keys.conversation),
          controller.signal,
        )
        if (!conversation.acquired) {
          refused = conversation.reason === "busy" ? "durable-busy" : "unavailable"
          return false
        }
        const sdkKey = claim.keys.sdk
        if (sdkKey === undefined) {
          durable = conversation.value
          prepared = true
          return true
        }
        // From this point, a failed SDK-key acquisition must release the conversation lease too.
        durable = conversation.value
        const sdk = await lock.tryAcquire(advisoryId(sdkKey), controller.signal)
        if (!sdk.acquired) {
          refused = sdk.reason === "busy" ? "durable-busy" : "unavailable"
          return false
        }
        durable = {
          release: async () => {
            await sdk.value.release()
            await conversation.value.release()
          },
        }
        prepared = true
        return true
      } catch {
        // A lock outage is an explicit refusal, not permission to start a cold session.
        refused = "unavailable"
        await durable?.release()
        durable = undefined
        return false
      } finally {
        signal?.removeEventListener("abort", onAbort)
      }
    })()
    return preparing
  }

  const release = (): void => {
    if (released) return
    released = true
    claim.release()
    // `release()` is synchronous at every call site. The lease releases on its own when its
    // connection dies; here we also release it explicitly and swallow a lost-connection error.
    const held = durable
    durable = undefined
    if (held !== undefined) void held.release().catch(() => undefined)
  }

  return {
    get held() {
      return claim.held && refused === undefined
    },
    get refused() {
      return refused
    },
    keys: claim.keys,
    own: claim.own,
    prepare,
    release,
  }
}

/**
 * FNV-1a folded to the signed 32-bit key space Postgres wants. This is the same derivation as
 * `advisoryLockKey` in `@multi-ai-router/db`, copied so this pure module stays usable in unit tests
 * with no database dependency. The two MUST stay byte-for-byte identical: a divergence would give
 * replicas different key numbers for the same session and break the fleet-wide claim.
 */
function advisoryId(name: string): number {
  let hash = 0x811c_9dc5
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index)
    hash = Math.imul(hash, 0x0100_0193)
  }
  return hash | 0
}
