import type { SessionLineageState } from "@multi-ai-router/db"
import type { ConversationView } from "./conversation"
import { classifyLineage, hashMessages, type LineageClass } from "./lineage"

/** Why a turn starts a fresh SDK session instead of rejoining one. Every value is client-visible
 * only as a cold prompt cache, never as an error — a fresh session still answers the question. */
export type FreshReason =
  | "no-session"
  /** Another turn of this same conversation is running right now — `session/inflight.ts`. */
  | "session-busy"
  | "unreadable-body"
  | "diverged"
  | "replay"
  | "tool-result-without-header"
  | "subagent-child"
  | "session-gone"
  | "no-rollback-point"
  /** The session lives on another Account and its transcript could not be carried here. */
  | "carry-failed"

/** What the SDK launch does with this turn. `deltaFrom` indexes the incoming messages. */
export type SessionPlan =
  | {
      readonly kind: "resume"
      readonly sdkSessionId: string
      readonly lineage: LineageClass
      readonly deltaFrom: number
      readonly carryFrom?: string
    }
  | {
      readonly kind: "fork"
      readonly sdkSessionId: string
      /** The SDK assistant message the fork rewinds to — `resumeSessionAt` verbatim. */
      readonly resumeSessionAt: string
      readonly deltaFrom: number
      /**
       * The Account the session was bound to, when that is not the Account this attempt runs on.
       * Its transcript has to be carried here before the launch can resume it
       * (`claude-sdk/session-carry.ts`); a carry that fails turns the plan `fresh`.
       */
      readonly carryFrom?: string
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
  /**
   * Another turn of this conversation is running right now, so this one is a concurrent arrival —
   * a client's hidden title or summary one-shot, in the overwhelming majority of cases
   * (`session/inflight.ts`). It may not resume a session that is in use, and the caller separately
   * sees to it that it records nothing.
   */
  readonly sessionBusy?: boolean
}

/**
 * The **never resume** rules, then the classification (§4).
 *
 * The tool-result rule is the subtle one: a headerless client running its own tool loop opens every
 * concurrent loop with the same first message, so they share a fingerprint — and resuming would
 * splice two independent loops into one transcript. With a client-supplied header there is no
 * guess to get wrong, so the rule does not apply.
 *
 * `sessionBusy` is the same hazard arriving through the *other* door, and the header does not save
 * you from it: a client that sends a header sends the **same** header on the hidden one-shots it
 * fires beside the visible turn. Two turns of one conversation in flight at once cannot share an
 * SDK session — the CLI refuses outright — so the later arrival runs detached
 * (`session/inflight.ts`).
 */
export function resolveLineage(input: ResolveLineageInput): SessionPlan {
  const { conversation, session } = input

  // First, because it is the only rule about what is happening *now* rather than about what the
  // conversation looks like: a session another turn is running cannot be resumed whatever the
  // hashes say, and asking the CLI anyway is the refusal this rule exists to prevent.
  if (input.sessionBusy === true) return { kind: "fresh", reason: "session-busy" }
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
        deltaFrom: pastOwnAnswer(conversation, overlap.deltaFrom),
      }
    case "rewrite": {
      // Rewind to the last answer both histories share, so the replaced tail — a hidden one-shot
      // and its reply — is not left in the transcript the real turn continues from.
      const point = rollbackPoint(session.lineage.assistantUuids, overlap.preserved)
      if (point === null) return { kind: "fresh", reason: "no-rollback-point" }
      return {
        kind: "fork",
        sdkSessionId: session.sdkSessionId,
        resumeSessionAt: point.uuid,
        deltaFrom: point.at + 1,
      }
    }
    case "undo": {
      const point = rollbackPoint(session.lineage.assistantUuids, overlap.preserved)
      // Without the SDK message uuid there is no way to name where to rewind to, and resuming
      // without one would answer a question the user already took back.
      if (point === null) return { kind: "fresh", reason: "no-rollback-point" }
      return {
        kind: "fork",
        sdkSessionId: session.sdkSessionId,
        resumeSessionAt: point.uuid,
        deltaFrom: overlap.deltaFrom,
      }
    }
    case "replay":
      return { kind: "fresh", reason: "replay" }
    default:
      return { kind: "fresh", reason: "diverged" }
  }
}

/**
 * The plan for a session carried in from `carryFrom` (`claude-sdk/session-carry.ts`).
 *
 * A plain continuation is turned into a **fork at the last recorded answer**. The bound Account's
 * transcript is not guaranteed to end there: an attempt that failed on it — the spent window that
 * caused this very failover — may already have appended the user's turn and the CLI's synthetic
 * "usage limit reached" reply. Rewinding to the answer the lineage recorded drops exactly that,
 * and the delta from there is the same one a resume would have sent. Compaction and modified
 * continuations keep their resume: their stored positions do not index the incoming messages, so
 * there is no rewind point to name. No uuid, likewise — a resume is still better than fresh.
 */
export function carriedPlan(
  plan: SessionPlan,
  carryFrom: string,
  uuids: readonly string[],
): SessionPlan {
  if (plan.kind === "fresh") return plan
  if (plan.kind === "resume" && plan.lineage === "continuation") {
    const point = rollbackPoint(uuids, plan.deltaFrom)
    if (point !== null) {
      return {
        kind: "fork",
        sdkSessionId: plan.sdkSessionId,
        resumeSessionAt: point.uuid,
        deltaFrom: point.at + 1,
        carryFrom,
      }
    }
  }
  return { ...plan, carryFrom }
}

/**
 * A resume delta starts where the session's own answer sits in the client's echo of it. The session
 * already holds that answer, so re-sending it framed it as a "prior conversation that could not be
 * resumed" every turn — a model told that, often enough, starts saying it has lost the context.
 * Skipped only when something follows it; a lone trailing assistant message is a prefill.
 */
function pastOwnAnswer(conversation: ConversationView, deltaFrom: number): number {
  const echoed = conversation.messages[deltaFrom]?.role === "assistant"
  return echoed && deltaFrom + 1 < conversation.messages.length ? deltaFrom + 1 : deltaFrom
}

/** The last known SDK assistant uuid at or before the last preserved message, and its position. */
function rollbackPoint(
  uuids: readonly string[],
  preserved: number,
): { readonly uuid: string; readonly at: number } | null {
  for (let at = Math.min(preserved, uuids.length) - 1; at >= 0; at--) {
    const uuid = uuids[at]
    if (uuid !== undefined && uuid !== "") return { uuid, at }
  }
  return null
}
