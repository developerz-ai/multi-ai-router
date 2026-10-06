import type { SessionRepository, SessionRow } from "@multi-ai-router/db"
import type { SessionCarrier, SessionCarryOutcome } from "../session-carry"
import { boundSession, entryOf } from "./bound"
import { createSessionCache, type SessionCache, type SessionCacheOptions } from "./cache"
import { readConversation } from "./conversation"
import { createSessionDeletionFence } from "./deletion-fence"
import { scopedKey, sessionFingerprint } from "./fingerprint"
import { claimSessionTurn, createSessionClaims, type SessionClaims } from "./inflight"
import { hashMessages } from "./lineage"
import { carriedPlan, type FreshReason, resolveLineage, type SessionPlan } from "./plan"
import { heldTurn, type SessionTurn, unrecordedTurn } from "./turn"
import { createSessionWrites } from "./writes"

export type { SessionTurn, TurnOutcome } from "./turn"

/**
 * Session lineage as the rest of the router uses it: one read before selection, one plan before an
 * SDK attempt, one write after it.
 *
 * The read is on the request path, so it is a **cache hit or a single indexed query** and never
 * more (docs/idea/01-architecture.md, performance budget). The write is not: `remember` returns
 * immediately and the row lands behind it, because a conversation that resumes one turn later than
 * it could have is a warm-cache miss, while a request waiting on an `UPDATE` is latency every
 * caller pays.
 *
 * **A failure here never fails a request.** A session table that is slow, locked, or gone costs a
 * cold prompt cache and nothing else — the turn is still answered, just from a fresh SDK session.
 * That is why every path below degrades to "no binding" rather than throwing.
 *
 * **A binding follows its conversation to another Account by carrying the transcript there.** An
 * SDK session id resumes only where its transcript file is, so a turn that lands on a different
 * Account than the binding names plans a resume *with* `carryFrom`, and `SessionTurn.prepare`
 * copies the file before the launch (`claude-sdk/session-carry.ts`). The row is never re-pointed
 * by hand: the turn's own `remember` moves it once the new Account has actually answered.
 */

/** What selection needs: an Account, and the session id that only resumes there. */
export interface StoredBinding {
  readonly accountId: string
  readonly sdkSessionId: string
}

export interface SessionStoreDeps {
  readonly repository: Pick<SessionRepository, "findByKey" | "upsert" | "clearAccount">
  readonly now: () => Date
  readonly cache?: Partial<SessionCacheOptions>
  /** Reported, never thrown. Composition points this at the logger. */
  readonly onError?: (operation: "read" | "write", error: unknown) => void
  /**
   * Moves a transcript between Accounts' config directories. Absent, a turn that lands off its
   * bound Account starts fresh (`carry-failed`), which is what every turn did before carrying.
   */
  readonly carrier?: SessionCarrier
  /** Every carry attempt's outcome, for the log line. */
  readonly onCarry?: (
    outcome: SessionCarryOutcome & { readonly fromAccountId: string; readonly toAccountId: string },
  ) => void
  /**
   * A turn bound on another Account that starts fresh **without** a carry attempt, and why. The
   * other half of `onCarry`: between the two, every turn that leaves its binding's Account is
   * accounted for in the log.
   */
  readonly onCarrySkipped?: (skip: SessionCarrySkip) => void
}

/** Why a turn off its bound Account never tried to carry: a lineage verdict, or carrying is off. */
export interface SessionCarrySkip {
  readonly reason: FreshReason | "carry-disabled"
  readonly fromAccountId: string
  readonly toAccountId: string
}

export const DEFAULT_SESSION_CACHE_MAX_ENTRIES = 4_096
export const DEFAULT_SESSION_CACHE_TTL_MS = 300_000
export const DEFAULT_SESSION_CACHE_NEGATIVE_TTL_MS = 30_000

export interface ResolveTurnInput {
  readonly apiKeyId: string
  /** The router's own session key: the client's header verbatim, else the byte fingerprint. */
  readonly sessionKey: string
  readonly keySource: "header" | "fingerprint"
  /** The Account this attempt runs against. Scopes the fingerprint and gates the stored binding. */
  readonly accountId: string
  /** Anthropic Messages bytes, already converted from the client's dialect if it differed. */
  readonly body: Uint8Array | null
  /** The client's own working directory, when a client reports one. Seeds the fingerprint. */
  readonly clientCwd?: string | null
  /** The SDK already reported this session gone. Never resumed again. */
  readonly sessionGone?: boolean
  /** The client marked this turn a fork or a subagent child. Never resumes the parent. */
  readonly forkOrSubagent?: boolean
}

export interface SessionStore {
  /**
   * The persisted binding for a session key, read through the cache. Called once per request,
   * before selection, because selection may not overrule it.
   */
  binding(apiKeyId: string, sessionKey: string): Promise<StoredBinding | undefined>
  /**
   * The bound session is gone for good — the SDK disowned the id. Drop it here and in Postgres.
   * A binding merely sitting on an Account that cannot serve right now is *not* invalidated: the
   * next attempt carries it (`SessionTurn.prepare`).
   */
  invalidate(apiKeyId: string, sessionKey: string): void
  /** Drop local lineage immediately; durable deletion clears targeted bindings transactionally. */
  invalidateAccount(accountId: string): Promise<void>
  /**
   * Before an SDK attempt: resume, fork, or start fresh, and how to record whichever happens.
   *
   * **It also claims the conversation for the duration of the turn.** A second request that arrives
   * on the same session key while the first is still running is *detached* — a fresh SDK session,
   * and nothing written back — because two turns cannot share one SDK session and the later arrival
   * is, in practice, a client's hidden title or summary one-shot rather than the conversation
   * (`session/inflight.ts`). The caller must call {@link SessionTurn.release} when the turn ends,
   * however it ends.
   */
  resolve(input: ResolveTurnInput): SessionTurn
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const cache: SessionCache = createSessionCache({
    maxEntries: deps.cache?.maxEntries ?? DEFAULT_SESSION_CACHE_MAX_ENTRIES,
    ttlMs: deps.cache?.ttlMs ?? DEFAULT_SESSION_CACHE_TTL_MS,
    negativeTtlMs: deps.cache?.negativeTtlMs ?? DEFAULT_SESSION_CACHE_NEGATIVE_TTL_MS,
    ...(deps.cache?.now === undefined ? {} : { now: deps.cache.now }),
  })
  const claims: SessionClaims = createSessionClaims()
  const fence = createSessionDeletionFence(
    Math.max(1, deps.cache?.maxEntries ?? DEFAULT_SESSION_CACHE_MAX_ENTRIES),
  )
  const write = createSessionWrites(deps.repository, fence, deps.onError)

  return {
    async binding(apiKeyId, sessionKey) {
      const key = scopedKey(apiKeyId, sessionKey)
      const cached = cache.get(key)
      if (cached !== undefined) return cached ?? undefined

      const reading = fence.read()
      let row: SessionRow | undefined
      try {
        row = await deps.repository.findByKey(apiKeyId, sessionKey)
      } catch (error) {
        // Not cached: a transient read failure must not be remembered as "no binding".
        reading.release()
        deps.onError?.("read", error)
        return undefined
      }

      const valid = reading.valid(row?.accountId ?? null)
      reading.release()
      if (!valid) return undefined
      const entry = entryOf(row)
      cache.set(key, entry)
      return entry ?? undefined
    },

    invalidate(apiKeyId, sessionKey) {
      const key = scopedKey(apiKeyId, sessionKey)
      cache.drop(key)
      cache.set(key, null)
      write(key, {
        apiKeyId,
        key: sessionKey,
        accountId: null,
        sdkSessionId: null,
        lineageState: null,
        // Untouched on purpose: a cleared row still ages out on its own idle clock.
        lastUsedAt: deps.now(),
      })
    },

    async invalidateAccount(accountId) {
      fence.invalidate(accountId)
      cache.dropAccount(accountId)
      try {
        await deps.repository.clearAccount(accountId)
      } catch (error) {
        deps.onError?.("write", error)
        throw error
      }
    },

    resolve(input) {
      const conversation = readConversation(input.body)
      const key = scopedKey(input.apiKeyId, input.sessionKey)
      const fingerprint =
        conversation === null
          ? null
          : sessionFingerprint({
              apiKeyId: input.apiKeyId,
              accountId: input.accountId,
              clientCwd: input.clientCwd ?? null,
              firstUserText: conversation.firstUserText,
            })

      const direct = cache.get(key)
      const session = boundSession(cache, direct, input.apiKeyId, input.accountId, fingerprint)
      const resolved = resolveLineage({
        session,
        conversation,
        keySource: input.keySource,
        ...(input.forkOrSubagent === undefined ? {} : { forkOrSubagent: input.forkOrSubagent }),
        ...(input.sessionGone === undefined ? {} : { sessionGone: input.sessionGone }),
      })
      const candidate =
        session?.carryFrom === undefined
          ? resolved
          : carriedPlan(resolved, session.carryFrom, session.lineage.assistantUuids)
      const claim = claimSessionTurn(
        claims,
        key,
        input.accountId,
        candidate.kind === "fresh" ? null : candidate.sdkSessionId,
      )
      const plan: SessionPlan = claim.held ? candidate : { kind: "fresh", reason: "session-busy" }
      const carryFrom = session?.carryFrom
      if (carryFrom !== undefined && plan.kind === "fresh") {
        deps.onCarrySkipped?.({
          reason: plan.reason,
          fromAccountId: carryFrom,
          toAccountId: input.accountId,
        })
      }

      // Nothing readable arrived, so there is nothing to hash and nothing worth remembering. The
      // plan already says so by name.
      if (conversation === null) return unrecordedTurn(plan, claim.release)

      // A detached turn is not the conversation: it runs, it answers, and it leaves no trace. Were
      // it to remember, a throwaway one-shot's fresh session would become the binding the user's
      // next real turn resumes from — the durable lineage advanced by a request nobody saw.
      if (!claim.held) return unrecordedTurn(plan, claim.release)

      const carrier = deps.carrier
      return heldTurn(
        {
          cache,
          write,
          now: deps.now,
          key,
          apiKeyId: input.apiKeyId,
          sessionKey: input.sessionKey,
          keySource: input.keySource,
          accountId: input.accountId,
          fingerprint,
          hashes: hashMessages(conversation.messages),
          storedUuids: session?.lineage.assistantUuids ?? [],
          claim,
          lease: fence.hold(input.accountId),
          prior: direct ?? null,
          carry: async (fromAccountId, sdkSessionId) => {
            const toAccountId = input.accountId
            if (carrier === undefined) {
              deps.onCarrySkipped?.({ reason: "carry-disabled", fromAccountId, toAccountId })
              return false
            }
            const outcome = await carrier.carry({ fromAccountId, toAccountId, sdkSessionId })
            deps.onCarry?.({ ...outcome, fromAccountId, toAccountId })
            return outcome.carried
          },
        },
        plan,
      )
    },
  }
}
