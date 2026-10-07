import { randomUUID } from "node:crypto"
import { fingerprintSessionKey } from "./read"

/**
 * The session key, in the order `05-routing-and-failover.md` fixes:
 *
 * 1. A **client-supplied session header**, when the client sends one. Authoritative — the client
 *    knows its own conversation boundaries better than the router can infer them.
 * 2. Otherwise a **fingerprint** of the conversation's captured opening bytes (`body/read.ts`).
 * 3. Without a usable opening capture, a fresh **unbound** key: no durable binding lookup or SDK
 *    resume is inferred from an empty fingerprint. Explicit client session headers still win.
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

/**
 * The header Claude Code sends on every request: its CLI session UUID. Provenance: Meridian verified
 * it against Claude Code 2.1.266 (pinned exactly by `--session-id`, distinct across sessions;
 * `tmp/meridian/docs/configuration.md`, their #820). Blast radius if the CLI drops it: Claude Code
 * falls back to plain fingerprint handling, and every tool round replays its whole history again.
 *
 * **It is a signal, not a session key.** The CLI reuses the id on the auxiliary one-shots it fires
 * beside a conversation (titles, summaries) and on its subagents, so keying on it alone puts
 * several unrelated histories under one key. It is mixed into the fingerprint instead — which only
 * separates more, never merges — and it marks the client as one that runs its own tool loop under a
 * named conversation, which is what lifts the headerless tool-result rule (`session/plan.ts`).
 */
export const CLAUDE_CODE_SESSION_HEADER = "x-claude-code-session-id"

/** Bounded so a hostile header cannot become an unbounded map key or log field. */
const MAX_SESSION_KEY_LENGTH = 200

export type SessionKeySource = "header" | "fingerprint" | "unbound"

export interface ResolvedSessionKey {
  readonly key: string
  readonly source: SessionKeySource
  /**
   * The client named its own agent session ({@link CLAUDE_CODE_SESSION_HEADER}). Its tool rounds
   * are turns of one conversation, not concurrent headerless loops that merely share an opening.
   */
  readonly clientToolLoop: boolean
}

export function resolveSessionKey(
  headers: Headers,
  apiKeyId: string,
  conversationPrefix: Uint8Array,
  sessionHeaders: readonly string[] = DEFAULT_SESSION_HEADERS,
): ResolvedSessionKey {
  const agentSession = headers
    .get(CLAUDE_CODE_SESSION_HEADER)
    ?.trim()
    .slice(0, MAX_SESSION_KEY_LENGTH)
  const clientToolLoop = agentSession !== undefined && agentSession.length > 0

  for (const name of sessionHeaders) {
    const supplied = headers.get(name)?.trim()
    if (supplied !== undefined && supplied.length > 0) {
      return { key: supplied.slice(0, MAX_SESSION_KEY_LENGTH), source: "header", clientToolLoop }
    }
  }
  if (conversationPrefix.length === 0) {
    return { key: `unbound_${randomUUID()}`, source: "unbound", clientToolLoop }
  }
  return {
    key: fingerprintSessionKey(apiKeyId, conversationPrefix, clientToolLoop ? agentSession : null),
    source: "fingerprint",
    clientToolLoop,
  }
}
