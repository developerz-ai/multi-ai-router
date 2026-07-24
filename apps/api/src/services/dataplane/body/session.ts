import { fingerprintSessionKey } from "./read"

/**
 * The session key, in the order `05-routing-and-failover.md` fixes:
 *
 * 1. A **client-supplied session header**, when the client sends one. Authoritative — the client
 *    knows its own conversation boundaries better than the router can infer them.
 * 2. Otherwise a **fingerprint** of the conversation's opening bytes (`body/read.ts`).
 *
 * It feeds `sticky` routing, where the same session and the same candidate set always produce the
 * same account: a warm prompt cache on the HTTP path, and a resumable conversation on the SDK one.
 */

/**
 * Headers clients use to name a conversation. Provenance: `x-session-id` is the convention the
 * OpenAI-ecosystem tools send; `anthropic-session-id` mirrors it on the Anthropic side;
 * `x-conversation-id` covers the editors that word it that way. Blast radius of a wrong entry:
 * unrelated requests share a session key and pin to one account, or one conversation splits across
 * accounts and loses its cache. Operator-overridable, never inferred from anything else.
 */
export const DEFAULT_SESSION_HEADERS: readonly string[] = [
  "x-session-id",
  "anthropic-session-id",
  "x-conversation-id",
]

/** Bounded so a hostile header cannot become an unbounded map key or log field. */
const MAX_SESSION_KEY_LENGTH = 200

export type SessionKeySource = "header" | "fingerprint"

export interface ResolvedSessionKey {
  readonly key: string
  readonly source: SessionKeySource
}

export function resolveSessionKey(
  headers: Headers,
  apiKeyId: string,
  conversationPrefix: Uint8Array,
  sessionHeaders: readonly string[] = DEFAULT_SESSION_HEADERS,
): ResolvedSessionKey {
  for (const name of sessionHeaders) {
    const supplied = headers.get(name)?.trim()
    if (supplied !== undefined && supplied.length > 0) {
      return { key: supplied.slice(0, MAX_SESSION_KEY_LENGTH), source: "header" }
    }
  }
  return { key: fingerprintSessionKey(apiKeyId, conversationPrefix), source: "fingerprint" }
}
