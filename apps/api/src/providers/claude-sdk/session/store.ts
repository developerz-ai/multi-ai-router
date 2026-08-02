import type { SessionLineageState, SessionRepository, SessionRow } from "@multi-ai-router/db"
import {
  createSessionCache,
  type SessionCache,
  type SessionCacheOptions,
  type SessionEntry,
} from "./cache"
import { readConversation } from "./conversation"
import { scopedKey, sessionFingerprint } from "./fingerprint"
import { hashMessages, resolveLineage, type SessionPlan } from "./lineage"

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
 * The binding is dropped, never moved (`services/routing/binding.ts`). An SDK session id is
 * meaningless off the Account that minted it, so re-pointing a row at a new Account would hand the
 * next request a resume token the new upstream has never seen.
 */

/** What selection needs: an Account, and the session id that only resumes there. */
export interface StoredBinding {
  readonly accountId: string
  readonly sdkSessionId: string
}

export interface SessionStoreDeps {
  readonly repository: Pick<SessionRepository, "findByKey" | "upsert">
  readonly now: () => Date
  readonly cache?: Partial<SessionCacheOptions>
  /** Reported, never thrown. Composition points this at the logger. */
  readonly onError?: (operation: "read" | "write", error: unknown) => void
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

export interface SessionTurn {
  readonly plan: SessionPlan
  /**
   * What the SDK told us, once it says it. Fire-and-forget: the cache is updated synchronously so
   * the next turn on this replica resumes even if the row is still in flight.
   *
   * @param assistantUuid the SDK message uuid this turn produced, when known. It is what an undo
   * later rewinds to, and its absence costs exactly that: an undo starts fresh instead of forking.
   */
  remember(sdkSessionId: string, assistantUuid?: string): void
}

export interface SessionStore {
  /**
   * The persisted binding for a session key, read through the cache. Called once per request,
   * before selection, because selection may not overrule it.
   */
  binding(apiKeyId: string, sessionKey: string): Promise<StoredBinding | undefined>
  /** Selection refused the binding. Drop it here and in Postgres; never move it to the new pick. */
  invalidate(apiKeyId: string, sessionKey: string): void
  /** Before an SDK attempt: resume, fork, or start fresh, and how to record whichever happens. */
  resolve(input: ResolveTurnInput): SessionTurn
}

export function createSessionStore(deps: SessionStoreDeps): SessionStore {
  const cache: SessionCache = createSessionCache({
    maxEntries: deps.cache?.maxEntries ?? DEFAULT_SESSION_CACHE_MAX_ENTRIES,
    ttlMs: deps.cache?.ttlMs ?? DEFAULT_SESSION_CACHE_TTL_MS,
    negativeTtlMs: deps.cache?.negativeTtlMs ?? DEFAULT_SESSION_CACHE_NEGATIVE_TTL_MS,
    ...(deps.cache?.now === undefined ? {} : { now: deps.cache.now }),
  })

  /**
   * Row writes, ordered **per session key**. Every write is still fire-and-forget from the
   * caller's side — nothing on the request path waits on Postgres — but within one key the
   * upserts land in the order they were issued. Without this, an `invalidate` (clear) and the
   * `remember` (bind) of the same request were two independent floating promises, and the clear
   * landing second left the row empty behind a cache that says bound; two requests rebinding the
   * same session concurrently could interleave the same way. The chain never grows unbounded: a
   * key's tail entry is removed the moment it settles with nothing queued behind it.
   */
  const pending = new Map<string, Promise<void>>()
  const write = (key: string, input: Parameters<SessionRepository["upsert"]>[0]): void => {
    const run = (): Promise<void> =>
      deps.repository.upsert(input).then(
        () => undefined,
        (error: unknown) => deps.onError?.("write", error),
      )
    const previous = pending.get(key)
    // Issued synchronously when nothing is in flight for this key, so an unqueued write costs the
    // same instant it always did; queued only behind its own key's predecessor.
    const tail = previous === undefined ? run() : previous.then(run)
    pending.set(key, tail)
    void tail.finally(() => {
      if (pending.get(key) === tail) pending.delete(key)
    })
  }

  return {
    async binding(apiKeyId, sessionKey) {
      const key = scopedKey(apiKeyId, sessionKey)
      const cached = cache.get(key)
      if (cached !== undefined) return cached ?? undefined

      let row: SessionRow | undefined
      try {
        row = await deps.repository.findByKey(apiKeyId, sessionKey)
      } catch (error) {
        // Not cached: a transient read failure must not be remembered as "no binding".
        deps.onError?.("read", error)
        return undefined
      }

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

    resolve(input) {
      const conversation = readConversation(input.body)
      const key = scopedKey(input.apiKeyId, input.sessionKey)
      const fingerprint =
        conversation === null
          ? null
          : sessionFingerprint({
              accountId: input.accountId,
              clientCwd: input.clientCwd ?? null,
              firstUserText: conversation.firstUserText,
            })

      const session = boundSession(cache, key, input.accountId, fingerprint)
      const plan = resolveLineage({
        session,
        conversation,
        keySource: input.keySource,
        ...(input.forkOrSubagent === undefined ? {} : { forkOrSubagent: input.forkOrSubagent }),
        ...(input.sessionGone === undefined ? {} : { sessionGone: input.sessionGone }),
      })

      // Nothing readable arrived, so there is nothing to hash and nothing worth remembering. The
      // plan already says so by name.
      if (conversation === null) return { plan, remember: () => {} }

      const hashes = hashMessages(conversation.messages)
      const carried = plan.kind === "fresh" ? [] : (session?.lineage.assistantUuids ?? [])

      return {
        plan,
        remember: (sdkSessionId, assistantUuid) => {
          const lineage = nextLineage(hashes, carried, assistantUuid)
          cache.set(key, { accountId: input.accountId, sdkSessionId, lineage })
          if (fingerprint !== null) cache.alias(fingerprint, key)
          write(key, {
            apiKeyId: input.apiKeyId,
            key: input.sessionKey,
            accountId: input.accountId,
            sdkSessionId,
            lineageState: lineage,
            fingerprintSource: input.keySource,
            lastUsedAt: deps.now(),
          })
        },
      }
    },
  }
}

/** The binding for *this* Account: the session key first, then the fingerprint alias behind it. */
function boundSession(
  cache: SessionCache,
  key: string,
  accountId: string,
  fingerprint: string | null,
): { readonly sdkSessionId: string; readonly lineage: SessionLineageState } | null {
  const direct = cache.get(key)
  if (direct !== undefined && direct !== null && direct.accountId === accountId) return direct

  if (fingerprint === null) return null
  const aliased = cache.aliased(fingerprint)
  if (aliased === undefined) return null

  const entry = cache.get(aliased)
  // The fingerprint is already Account-scoped, so a mismatch here means the alias outlived the
  // binding it named. Answering with it would resume on an Account that never saw this session.
  if (entry === undefined || entry === null) return null
  return entry.accountId === accountId ? entry : null
}

/**
 * The state stored beside the session id: one hash per message the SDK has now seen, and the SDK
 * message uuids that name where to rewind to.
 *
 * The uuid for this turn is written **one past the end**, because that is the position the client
 * will send the assistant's answer back at next turn — the index an undo has to be able to name.
 */
function nextLineage(
  hashes: readonly string[],
  carried: readonly string[],
  assistantUuid: string | undefined,
): SessionLineageState {
  const assistantUuids = carried.slice(0, hashes.length)
  while (assistantUuids.length < hashes.length) assistantUuids.push("")
  assistantUuids.push(assistantUuid ?? "")
  return { prefixHashes: hashes, assistantUuids }
}

/** A row binds only when it names both halves. Either alone resumes nowhere. */
function entryOf(row: SessionRow | undefined): SessionEntry | null {
  const accountId = row?.accountId ?? null
  const sdkSessionId = row?.sdkSessionId ?? null
  if (accountId === null || sdkSessionId === null) return null
  return {
    accountId,
    sdkSessionId,
    lineage: row?.lineageState ?? { prefixHashes: [], assistantUuids: [] },
  }
}
