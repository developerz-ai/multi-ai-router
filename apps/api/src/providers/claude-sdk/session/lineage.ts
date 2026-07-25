import { createHash } from "node:crypto"
import type { SessionLineageState } from "@multi-ai-router/db"
import type { ConversationView, LineageMessage } from "./conversation"

/**
 * Is the conversation in front of us a legal descendant of the one this SDK session holds — and if
 * so, how do we rejoin it? (docs/idea/11-anthropic-agent-sdk.md §4)
 *
 * A pure function over stored hashes and incoming hashes. No clock, no store, no SDK. That matters
 * because every one of the six classes below is a *correctness* decision, not an optimization:
 *
 * | Class | Condition | Action |
 * |---|---|---|
 * | continuation | stored is a prefix of incoming and it grew | `resume`, send the delta |
 * | modified continuation | most of the prefix survives and it grew | `resume`, restate the hashes |
 * | compaction | a contiguous stored **suffix** reappears after position 0 | `resume` from after it |
 * | undo | the prefix is preserved and the conversation **shrank** | `forkSession` + `resumeSessionAt` |
 * | diverged | no meaningful overlap | fresh session |
 * | replay | the prefix matches and nothing grew | fresh session |
 *
 * Two subtleties earned by other people's bugs. **Compaction needs positional overlap, not set
 * membership** — duplicate messages match at unrelated positions and produce a resume into the
 * wrong point of the history. And **replay is deliberately not a resume**: an identical resend
 * would re-send the last user message into a session that already answered it, accumulating ghost
 * context turn after turn.
 *
 * Resuming sends only the delta, and the delta is user content: an assistant message inside it is
 * this SDK session's own answer echoed back by the client, and replaying it teaches the model to
 * fabricate transcripts (§4).
 */

/**
 * How much of the stored prefix may change and still count as the same conversation.
 *
 * Clients mutate earlier messages harmlessly all the time — a moved `cache_control` marker (already
 * stripped before hashing), a re-rendered system reminder, a normalized whitespace run. Below this
 * share of surviving messages the safe reading is that this is a different conversation.
 */
const MODIFIED_PREFIX_MIN_RATIO = 0.6

/**
 * The shortest stored suffix a compaction may be recognized by. Two messages, because one message
 * matching at an arbitrary position is what "set membership instead of positional overlap" looks
 * like from the inside — a coincidence, resumed into the wrong point of the history.
 */
const MIN_COMPACTION_OVERLAP = 2

export type LineageClass =
  | "continuation"
  | "modified-continuation"
  | "compaction"
  | "undo"
  | "diverged"
  | "replay"

export interface LineageOverlap {
  readonly lineage: LineageClass
  /**
   * The first incoming message this SDK session has not seen. Everything before it is already in
   * the session's own transcript; everything from here is the delta a resume sends.
   */
  readonly deltaFrom: number
  /** How many stored messages survive into the incoming conversation. Names the rollback point. */
  readonly preserved: number
}

/** One hash per message, in order. Truncated to 128 bits: this is an identity check, not a MAC. */
export function hashMessages(messages: readonly LineageMessage[]): string[] {
  return messages.map((message) =>
    createHash("sha256").update(message.normalized, "utf8").digest("hex").slice(0, 32),
  )
}

export function classifyLineage(
  stored: readonly string[],
  incoming: readonly string[],
): LineageOverlap {
  if (stored.length === 0 || incoming.length === 0) {
    return { lineage: "diverged", deltaFrom: 0, preserved: 0 }
  }

  const matched = commonPrefix(stored, incoming)

  if (incoming.length === stored.length && matched === stored.length) {
    // Byte-identical resend. Resuming would answer it twice into one transcript.
    return { lineage: "replay", deltaFrom: 0, preserved: matched }
  }

  if (incoming.length > stored.length) {
    if (matched === stored.length) {
      return { lineage: "continuation", deltaFrom: stored.length, preserved: matched }
    }
    if (matched >= Math.ceil(stored.length * MODIFIED_PREFIX_MIN_RATIO)) {
      return { lineage: "modified-continuation", deltaFrom: stored.length, preserved: matched }
    }
    return compactionOr("diverged", stored, incoming, matched)
  }

  // It shrank. A preserved prefix is an undo; a preserved *suffix* somewhere after position 0 is
  // the client having summarized its own history in front of it.
  if (matched === incoming.length) {
    return { lineage: "undo", deltaFrom: incoming.length, preserved: matched }
  }
  return compactionOr("diverged", stored, incoming, matched)
}

/** The compaction test, with the caller's verdict when no stored suffix reappears. */
function compactionOr(
  fallback: LineageClass,
  stored: readonly string[],
  incoming: readonly string[],
  matched: number,
): LineageOverlap {
  const found = findStoredSuffix(stored, incoming)
  if (found === null) return { lineage: fallback, deltaFrom: 0, preserved: matched }
  return { lineage: "compaction", deltaFrom: found.end, preserved: found.length }
}

/**
 * The longest contiguous stored **suffix** appearing in `incoming` at a position after 0 — the
 * shape a client-side compaction leaves behind: a summary first, then the recent turns verbatim.
 *
 * Positional, and anchored on the stored side's end: a match that does not run to the last stored
 * message is not a suffix, it is a coincidence.
 */
function findStoredSuffix(
  stored: readonly string[],
  incoming: readonly string[],
): { readonly end: number; readonly length: number } | null {
  const longest = Math.min(stored.length, incoming.length - 1)

  for (let length = longest; length >= MIN_COMPACTION_OVERLAP; length--) {
    const from = stored.length - length
    for (let at = 1; at + length <= incoming.length; at++) {
      if (segmentsMatch(stored, from, incoming, at, length)) {
        return { end: at + length, length }
      }
    }
  }
  return null
}

function segmentsMatch(
  stored: readonly string[],
  from: number,
  incoming: readonly string[],
  at: number,
  length: number,
): boolean {
  for (let i = 0; i < length; i++) {
    if (stored[from + i] !== incoming[at + i]) return false
  }
  return true
}

function commonPrefix(stored: readonly string[], incoming: readonly string[]): number {
  const limit = Math.min(stored.length, incoming.length)
  let matched = 0
  while (matched < limit && stored[matched] === incoming[matched]) matched++
  return matched
}

/** Why a turn starts a fresh SDK session instead of rejoining one. Every value is client-visible
 * only as a cold prompt cache, never as an error — a fresh session still answers the question. */
export type FreshReason =
  | "no-session"
  | "unreadable-body"
  | "diverged"
  | "replay"
  | "tool-result-without-header"
  | "subagent-child"
  | "session-gone"
  | "no-rollback-point"

/** What the SDK launch does with this turn. `deltaFrom` indexes the incoming messages. */
export type SessionPlan =
  | {
      readonly kind: "resume"
      readonly sdkSessionId: string
      readonly lineage: LineageClass
      readonly deltaFrom: number
    }
  | {
      readonly kind: "fork"
      readonly sdkSessionId: string
      /** The SDK assistant message the fork rewinds to — `resumeSessionAt` verbatim. */
      readonly resumeSessionAt: string
      readonly deltaFrom: number
    }
  | { readonly kind: "fresh"; readonly reason: FreshReason }

export interface ResolveLineageInput {
  /** The stored binding for this Account, or null when the session has never run here. */
  readonly session: { readonly sdkSessionId: string; readonly lineage: SessionLineageState } | null
  readonly conversation: ConversationView | null
  /** How the router named this session. A fingerprint is a guess; a header is the client's word. */
  readonly keySource: "header" | "fingerprint"
  /** The client marked this a fork or a subagent child. Never resumes the parent's session. */
  readonly forkOrSubagent?: boolean
  /** The SDK already told us this session is gone. Never resumed again. */
  readonly sessionGone?: boolean
}

/**
 * The **never resume** rules, then the classification (§4).
 *
 * The tool-result rule is the subtle one: a headerless client running its own tool loop opens every
 * concurrent loop with the same first message, so they share a fingerprint — and resuming would
 * splice two independent loops into one transcript. With a client-supplied header there is no
 * guess to get wrong, so the rule does not apply.
 */
export function resolveLineage(input: ResolveLineageInput): SessionPlan {
  const { conversation, session } = input

  if (input.sessionGone === true) return { kind: "fresh", reason: "session-gone" }
  if (input.forkOrSubagent === true) return { kind: "fresh", reason: "subagent-child" }
  if (conversation === null) return { kind: "fresh", reason: "unreadable-body" }
  if (input.keySource === "fingerprint" && conversation.endsWithToolResult) {
    return { kind: "fresh", reason: "tool-result-without-header" }
  }
  if (session === null) return { kind: "fresh", reason: "no-session" }

  const overlap = classifyLineage(session.lineage.prefixHashes, hashMessages(conversation.messages))

  switch (overlap.lineage) {
    case "continuation":
    case "modified-continuation":
    case "compaction":
      return {
        kind: "resume",
        sdkSessionId: session.sdkSessionId,
        lineage: overlap.lineage,
        deltaFrom: overlap.deltaFrom,
      }
    case "undo": {
      const resumeSessionAt = rollbackPoint(session.lineage.assistantUuids, overlap.preserved)
      // Without the SDK message uuid there is no way to name where to rewind to, and resuming
      // without one would answer a question the user already took back.
      if (resumeSessionAt === null) return { kind: "fresh", reason: "no-rollback-point" }
      return {
        kind: "fork",
        sdkSessionId: session.sdkSessionId,
        resumeSessionAt,
        deltaFrom: overlap.deltaFrom,
      }
    }
    case "replay":
      return { kind: "fresh", reason: "replay" }
    default:
      return { kind: "fresh", reason: "diverged" }
  }
}

/** The last known SDK assistant uuid at or before the last preserved message. */
function rollbackPoint(uuids: readonly string[], preserved: number): string | null {
  for (let at = Math.min(preserved, uuids.length) - 1; at >= 0; at--) {
    const uuid = uuids[at]
    if (uuid !== undefined && uuid !== "") return uuid
  }
  return null
}
