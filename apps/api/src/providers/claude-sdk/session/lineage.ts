import { createHash } from "node:crypto"
import type { SessionLineageState } from "@multi-ai-router/db"
import type { LineageMessage } from "./conversation"

/**
 * Is the conversation in front of us a legal descendant of the one this SDK session holds — and if
 * so, how do we rejoin it? (docs/idea/11-anthropic-agent-sdk.md §4)
 *
 * A pure function over stored hashes and incoming hashes. No clock, no store, no SDK. That matters
 * because every one of the seven classes below is a *correctness* decision, not an optimization:
 *
 * | Class | Condition | Action |
 * |---|---|---|
 * | continuation | stored is a prefix of incoming and it grew | `resume`, send the delta |
 * | modified continuation | most of the prefix survives, it grew, the stored tail realigns | `resume`, restate the hashes |
 * | rewrite | most of the prefix survives, then the stored tail is **replaced** by new content | rewind before it, send from there |
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
  | "rewrite"
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

  if (incoming.length > stored.length && matched === stored.length) {
    return { lineage: "continuation", deltaFrom: stored.length, preserved: matched }
  }

  // It shrank with nothing new. A preserved prefix is an undo.
  if (incoming.length <= stored.length && matched === incoming.length) {
    return { lineage: "undo", deltaFrom: incoming.length, preserved: matched }
  }

  if (matched >= Math.ceil(stored.length * MODIFIED_PREFIX_MIN_RATIO)) {
    // The stored tail still sits where it was: something earlier was mutated in place, and the
    // session already holds it in its old form. Only what lies past the stored end is new.
    const last = stored.length - 1
    if (incoming.length > stored.length && incoming[last] === stored[last]) {
      return { lineage: "modified-continuation", deltaFrom: stored.length, preserved: matched }
    }
    // The tail after `matched` was *replaced* — a client's hidden one-shot (a prompt suggestion,
    // a title) advanced the session, then the real turn arrived on top of the answer before it.
    // Every incoming message past `matched` is unseen; sending only what lies past the stored end
    // dropped the user's actual message and answered a bare system reminder instead.
    return { lineage: "rewrite", deltaFrom: matched, preserved: matched }
  }

  // A preserved *suffix* somewhere after position 0 is the client having summarized its own
  // history in front of it.
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

/**
 * The state stored beside the session id: one hash per message the SDK has now seen, and the SDK
 * message uuids that name where to rewind to.
 *
 * The uuid for this turn is written **one past the end**, because that is the position the client
 * will send the assistant's answer back at next turn — the index an undo has to be able to name.
 */
export function nextLineage(
  hashes: readonly string[],
  carried: readonly string[],
  assistantUuid: string | undefined,
): SessionLineageState {
  const assistantUuids = carried.slice(0, hashes.length)
  while (assistantUuids.length < hashes.length) assistantUuids.push("")
  assistantUuids.push(assistantUuid ?? "")
  return { prefixHashes: hashes, assistantUuids }
}
