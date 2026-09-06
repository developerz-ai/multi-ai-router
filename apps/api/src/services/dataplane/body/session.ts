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
 *
 * **`x-parent-session-id` is deliberately not here, and that absence is the rule.** A subagent runs
 * in its own session, concurrently with its parent by design, and it sends its own `x-session-id`
 * for it. Keying the child on its parent would bind two live conversations to one SDK session —
 * which the CLI refuses outright — so the child's own id is both the correct key and the only one
 * this list will ever read. The parent id is logged (`middleware/logger.ts`) and routes nothing.
 *
 * Header lookup is case-insensitive by the `Headers` contract, so a client sending `X-Session-Id`
 * is matched by the lower-case entry above; the spellings here are canonical, not exhaustive.
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
