import type { SessionLineageState, SessionRow } from "@multi-ai-router/db"
import type { CachedSession, SessionCache, SessionEntry } from "./cache"
import { scopedKey } from "./fingerprint"

/** The binding a turn can rejoin, and where its transcript lives when that is another Account. */
export interface BoundSession {
  readonly sdkSessionId: string
  readonly lineage: SessionLineageState
  readonly carryFrom?: string
}

/**
 * The binding this turn can rejoin: the session key first, then the fingerprint alias behind it.
 *
 * A direct binding on **another** Account is still this conversation — the request names it by
 * key — so it comes back with `carryFrom`, and the transcript follows the turn. An alias never
 * does: the fingerprint is Account-scoped, so an alias naming another Account's session is one that
 * outlived the binding it pointed at.
 *
 * @param direct the session key's own cached value, read once by the caller.
 */
export function boundSession(
  cache: SessionCache,
  direct: CachedSession,
  apiKeyId: string,
  accountId: string,
  fingerprint: string | null,
): BoundSession | null {
  if (direct !== undefined && direct !== null) {
    if (direct.accountId === accountId) return direct
    return {
      sdkSessionId: direct.sdkSessionId,
      lineage: direct.lineage,
      carryFrom: direct.accountId,
    }
  }

  if (fingerprint === null) return null
  const aliased = cache.aliased(fingerprint)
  if (aliased === undefined || !aliased.startsWith(scopedKey(apiKeyId, ""))) return null

  const entry = cache.get(aliased)
  // The fingerprint is key- and Account-scoped, so a mismatch means the alias outlived the
  // binding it named. Answering with it would resume on an Account that never saw this session.
  if (entry === undefined || entry === null) return null
  return entry.accountId === accountId ? entry : null
}

/** A row binds only when it names both halves. Either alone resumes nowhere. */
export function entryOf(row: SessionRow | undefined): SessionEntry | null {
  const accountId = row?.accountId ?? null
  const sdkSessionId = row?.sdkSessionId ?? null
  if (accountId === null || sdkSessionId === null) return null
  return {
    accountId,
    sdkSessionId,
    lineage: row?.lineageState ?? { prefixHashes: [], assistantUuids: [] },
  }
}
