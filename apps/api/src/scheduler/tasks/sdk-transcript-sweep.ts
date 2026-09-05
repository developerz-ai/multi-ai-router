import { describeError } from "@multi-ai-router/core"
import type { SdkTranscripts, TranscriptEntry } from "../../providers/claude-sdk/transcripts"
import type { ScheduledTask, TaskOutcome } from "../types"

/**
 * The retention sweep for Agent-SDK session transcripts on the config-directory volume.
 *
 * Every Claude subscription turn leaves a transcript the `claude` CLI writes for `--resume`
 * (`providers/claude-sdk/transcripts.ts` names exactly what and where), and nothing removed them:
 * the `sessions` table that can still resume one is swept after `RETENTION_SESSIONS_HOURS`, the
 * files it pointed at were kept forever. This task is the other half of that retention — the same
 * default window, the same bounded-batch shape (`janitor.ts`, `config-dir-reap.ts`), and the same
 * rule that every number here is config (`RETENTION_SDK_TRANSCRIPT_HOURS`,
 * `SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES`, `SWEEP_BATCH_SIZE`; non-negotiable 11).
 *
 * **Age is the transcript's own mtime**, which the CLI bumps on every turn it serves, so "older
 * than the window" means "no turn in the window" — the same fact `sessions.last_used_at` records,
 * read from the artifact itself rather than joined against the table. That keeps the sweep off
 * Postgres entirely and makes it correct for a transcript whose row is already gone.
 *
 * **A removed transcript is safe to have removed.** A conversation that resumes it after the
 * sweep — the window being shorter than the row's, or the two racing — gets the CLI's "No
 * conversation found with session ID", which `errors.ts` classifies `stale-session`: the binding
 * is evicted and the turn is replayed in place from the client's full transcript
 * (`services/dataplane/sdk-attempt.ts`, `services/routing/failover.ts`). The cost is one cold
 * prompt cache, never a failed request — which is why this file needs no repository.
 *
 * **What it never touches** is the reason the adapter exists: credentials and settings live in the
 * same directories, and the survey only ever names `<uuid>.jsonl` and `<uuid>/` under
 * `projects/<slug>/`. The plan below is pure and cannot widen that.
 */

export interface TranscriptSweepPlan {
  /** Removable, oldest first, capped at the batch limit. */
  readonly sweep: readonly TranscriptEntry[]
  /** Inside the retention window — a later tick decides. */
  readonly young: number
  /** Bytes the removable transcripts hold, for the log line. */
  readonly bytes: number
  /** The batch limit cut the list short: the next tick continues. */
  readonly remaining: boolean
}

export interface TranscriptSweepPlanInput {
  readonly entries: readonly TranscriptEntry[]
  readonly now: Date
  /** `RETENTION_SDK_TRANSCRIPT_HOURS`, in milliseconds. */
  readonly retentionMs: number
  /** Sessions removed in one tick. */
  readonly limit: number
}

/** Decides what may go. Pure (non-negotiable 9): the survey and the instant are handed in. */
export function planTranscriptSweep(input: TranscriptSweepPlanInput): TranscriptSweepPlan {
  const cutoffMs = input.now.getTime() - input.retentionMs
  const candidates: TranscriptEntry[] = []
  let young = 0

  for (const entry of input.entries) {
    if (entry.changedAtMs >= cutoffMs) {
      young += 1
      continue
    }
    candidates.push(entry)
  }

  // Oldest first, so a backlog larger than one batch drains deterministically.
  candidates.sort((a, b) => a.changedAtMs - b.changedAtMs)
  const sweep = candidates.slice(0, Math.max(0, input.limit))

  return {
    sweep,
    young,
    bytes: sweep.reduce((total, entry) => total + (entry.transcript?.bytes ?? 0), 0),
    remaining: candidates.length > sweep.length,
  }
}

export interface TranscriptSweepDeps {
  readonly transcripts: Pick<SdkTranscripts, "root" | "survey" | "remove">
  /** `RETENTION_SDK_TRANSCRIPT_HOURS`, in milliseconds. Config, never a constant here. */
  readonly retentionMs: number
  /** `SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`, counted in sessions rather than rows. */
  readonly batchSize: number
}

export function createTranscriptSweepTask(deps: TranscriptSweepDeps): ScheduledTask {
  return {
    name: "sdk_transcript_sweep",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      const entries = await deps.transcripts.survey()
      const plan = planTranscriptSweep({
        entries,
        now,
        retentionMs: deps.retentionMs,
        limit: deps.batchSize,
      })

      let removed = 0
      let stopped = false
      try {
        for (const entry of plan.sweep) {
          // Between sessions, so a shutdown never leaves a transcript half-removed for long.
          if (signal.aborted) {
            stopped = true
            break
          }
          await deps.transcripts.remove(entry)
          removed += 1
        }
      } catch (error) {
        // Caught so the count survives: what was removed is gone whatever happens next, and the
        // runner redacts and truncates the full cause chain before it reaches the run row.
        return {
          outcome: "failed",
          itemsProcessed: removed,
          error: describeError(error, Number.POSITIVE_INFINITY),
        }
      }

      // One line per tick. Session ids are not logged: a transcript's name is the resume token
      // of a conversation, and an operator asking "what did the sweep do" needs the counts.
      logger.info("sdk transcript sweep", {
        root: deps.transcripts.root,
        surveyed: entries.length,
        removed,
        bytes: plan.bytes,
        withinRetention: plan.young,
        remaining: plan.remaining,
      })

      return {
        outcome: stopped || plan.remaining ? "partial" : "success",
        itemsProcessed: removed,
      }
    },
  }
}
