import type { SessionLineageState, SessionRepository } from "@multi-ai-router/db"
import type { SessionCache, SessionEntry } from "./cache"
import { nextLineage } from "./lineage"
import type { SessionPlan } from "./plan"

/**
 * How the attempt that ran this turn ended. `failed` means nothing reached the client — a spent
 * window, a crash before output — so the turn never answered and is not part of the lineage.
 */
export type TurnOutcome = "answered" | "failed"

export interface SessionTurn {
  readonly plan: SessionPlan
  /**
   * Before the launch: a plan that resumes a session bound on **another** Account carries that
   * session's transcript to this one (`claude-sdk/session-carry.ts`), the way a local `claude`
   * user's `/login` keeps the conversation file and swaps only the credential beside it.
   *
   * Resolves to the turn to run — this one, or a **fresh** one when the carry could not happen, so
   * the launch never resumes an id this Account has never seen. Never rejects. A turn with nothing
   * to carry resolves to itself at once.
   */
  prepare(): Promise<SessionTurn>
  /**
   * What the SDK told us, once it says it. Fire-and-forget: the cache is updated synchronously so
   * the next turn on this replica resumes even if the row is still in flight.
   *
   * **A detached turn remembers nothing** — see `SessionStore.resolve`. It is a no-op there
   * rather than a flag the caller has to check, because the one thing that must not happen is a
   * hidden one-shot's throwaway session becoming the conversation's binding.
   *
   * @param assistantUuid the SDK message uuid this turn produced, when known. It is what an undo
   * later rewinds to, and its absence costs exactly that: an undo starts fresh instead of forking.
   */
  remember(sdkSessionId: string, assistantUuid?: string): void
  /**
   * This turn is finished with the SDK session, so the next turn of the conversation may have it.
   *
   * Idempotent, and called **unconditionally** — from the turn's own end inside the invoker, and
   * again from the attempt's failure path, because those two cannot coordinate and a claim that
   * leaks parks a conversation on fresh sessions until the process restarts. A turn that holds no
   * claim releases nothing (`session/inflight.ts`).
   *
   * **A `failed` turn withdraws what it remembered.** The CLI names its session in `system`/`init`
   * before it learns the window is spent, so a refused attempt still reports — and recording it
   * would move the binding onto the account that refused and claim the user's unanswered message
   * as seen, turning the retry into a fresh `replay` instead of a carry from where the
   * conversation was last answered. The first release decides; later ones only release.
   */
  release(outcome?: TurnOutcome): void
}

/** A turn that records nothing: a detached one-shot, or a body with nothing to hash. */
export function unrecordedTurn(plan: SessionPlan, release: () => void): SessionTurn {
  const turn: SessionTurn = {
    plan,
    prepare: () => Promise.resolve(turn),
    remember: () => {},
    release,
  }
  return turn
}

/** Everything a held turn needs to write its outcome back, fixed when the turn was resolved. */
export interface HeldTurnContext {
  readonly cache: SessionCache
  readonly write: (key: string, input: Parameters<SessionRepository["upsert"]>[0]) => void
  readonly now: () => Date
  readonly key: string
  readonly apiKeyId: string
  readonly sessionKey: string
  readonly keySource: "header" | "fingerprint"
  readonly accountId: string
  readonly fingerprint: string | null
  readonly hashes: readonly string[]
  /** The stored lineage's assistant uuids, before this turn's plan narrows them. */
  readonly storedUuids: SessionLineageState["assistantUuids"]
  readonly claim: { own(sdkSessionId: string): boolean; release(): void }
  readonly lease: { valid(): boolean; release(): void }
  /** The binding this session key held when the turn was resolved, to restore if it fails. */
  readonly prior: SessionEntry | null
  /** Moves `sdkSessionId` from `fromAccountId` to this turn's Account. Absent, nothing carries. */
  readonly carry?: (fromAccountId: string, sdkSessionId: string) => Promise<boolean>
}

/** A turn that owns its conversation: it prepares, launches, and records what the SDK named. */
export function heldTurn(ctx: HeldTurnContext, plan: SessionPlan): SessionTurn {
  const uuids = plan.kind === "fresh" ? [] : ctx.storedUuids
  // A fork's uuids past its rollback point name the abandoned branch. A carried transcript is the
  // same file byte for byte (paths aside), so its uuids still name the same messages.
  const carried = plan.kind === "fork" ? uuids.slice(0, plan.deltaFrom) : uuids

  let remembered = false
  let released = false
  const release = (outcome: TurnOutcome = "answered") => {
    if (!released) {
      released = true
      // Still under the claim, so no other turn of this conversation can have written since.
      if (outcome === "failed" && remembered && ctx.lease.valid()) withdraw(ctx)
    }
    ctx.claim.release()
    ctx.lease.release()
  }

  const turn: SessionTurn = {
    plan,
    release,
    async prepare() {
      if (plan.kind === "fresh" || plan.carryFrom === undefined) return turn
      const moved = (await ctx.carry?.(plan.carryFrom, plan.sdkSessionId)) ?? false
      // Same claim and lease: the conversation is still this turn's, only the plan changed.
      return moved ? turn : heldTurn(ctx, { kind: "fresh", reason: "carry-failed" })
    },
    remember(sdkSessionId, assistantUuid) {
      if (!ctx.lease.valid() || !ctx.claim.own(sdkSessionId)) return
      const lineage = nextLineage(ctx.hashes, carried, assistantUuid)
      remembered = true
      ctx.cache.set(ctx.key, { accountId: ctx.accountId, sdkSessionId, lineage })
      if (ctx.fingerprint !== null) ctx.cache.alias(ctx.fingerprint, ctx.key)
      ctx.write(ctx.key, {
        apiKeyId: ctx.apiKeyId,
        key: ctx.sessionKey,
        accountId: ctx.accountId,
        sdkSessionId,
        lineageState: lineage,
        fingerprintSource: ctx.keySource,
        lastUsedAt: ctx.now(),
      })
    },
  }
  return turn
}

/** Puts the session key back the way the turn found it: the prior binding, or none. */
function withdraw(ctx: HeldTurnContext): void {
  const { prior } = ctx
  ctx.cache.set(ctx.key, prior)
  ctx.write(ctx.key, {
    apiKeyId: ctx.apiKeyId,
    key: ctx.sessionKey,
    accountId: prior?.accountId ?? null,
    sdkSessionId: prior?.sdkSessionId ?? null,
    lineageState: prior?.lineage ?? null,
    lastUsedAt: ctx.now(),
  })
}
