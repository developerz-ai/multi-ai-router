import { describeError } from "@multi-ai-router/core"
import type { AccountRepository } from "@multi-ai-router/db"
import type { AccountConfigDirs, ConfigDirEntry } from "../../providers/claude-sdk/config-dir"
import type { ScheduledTask, TaskOutcome } from "../types"

/**
 * The reaper for `CLAUDE_CONFIG_DIR`s no account claims any more.
 *
 * **This is a security sweep, not a disk-space one.** What sits in one of those directories is a
 * live subscription's OAuth credentials in cleartext, written by the `claude` CLI and never touched
 * by us (docs/idea/07-security.md, docs/idea/11-anthropic-agent-sdk.md §3). A directory whose
 * account no longer exists is a credential nothing will ever rotate, revoke, or notice — it just
 * stays on the persistent volume until someone looks. Bytes are not the reason to remove it.
 *
 * Two ways one is created, and only the first is closed elsewhere:
 *
 * - **Account deleted.** `AccountsService.remove` removes the directory with the row, so the
 *   ordinary path leaves nothing behind. A crash between the two halves does.
 * - **Crash between provision and insert.** `provision` runs *before* `accounts.create`
 *   (`services/accounts/service.ts`) because the directory has to exist before anything can log in
 *   to it. The insert's own failure path takes the directory back; a process that dies in that
 *   window cannot, and `accounts_config_dir_key` then makes the path unusable by anyone else.
 *
 * Three rules keep a sweep over live credentials from becoming the outage it is meant to prevent:
 *
 * 1. **Directories are read before accounts.** A directory minted after the survey cannot be in it,
 *    while a row inserted after the survey is still read by the query below — so the sequence only
 *    ever makes the set of suspects smaller. Reversing the two would widen exactly the window the
 *    grace period exists to cover.
 * 2. **A grace period, from config.** `RETENTION_ORPHAN_CONFIG_DIR_HOURS`. Nothing recent is
 *    touched, so a directory provisioned seconds before its insert is never a candidate however the
 *    two reads interleave.
 * 3. **Only names that are account ids.** Anything else on the volume is not this router's to
 *    remove; it is counted so it shows up in the log, and left exactly where it is.
 */

/** An entry the plan is prepared to remove: named after an account id, and past its grace. */
export type OrphanConfigDir = ConfigDirEntry & { readonly accountId: string }

/** What one survey of the root found, in the terms an operator reads it in. */
export interface ReapPlan {
  /** Removable, oldest first, capped at the batch limit. */
  readonly reap: readonly OrphanConfigDir[]
  /** Named after an account that still exists. Never touched. */
  readonly claimed: number
  /** Unclaimed, but inside the grace window — a future tick decides, not this one. */
  readonly young: number
  /** Not named after an account id at all. Not ours; counted so it is visible. */
  readonly foreign: number
  /** The batch limit cut the list short: there is more, and the next tick continues. */
  readonly remaining: boolean
}

export interface ReapPlanInput {
  /** The survey, as `AccountConfigDirs.list()` returned it. */
  readonly entries: readonly ConfigDirEntry[]
  /** Every account id in the table. Compared case-insensitively — see the note in the body. */
  readonly liveAccountIds: ReadonlySet<string>
  /** The tick's clock reading. */
  readonly now: Date
  /** `RETENTION_ORPHAN_CONFIG_DIR_HOURS`, in milliseconds. */
  readonly graceMs: number
  /** Directories removable in one tick. The rest wait for the next one. */
  readonly limit: number
}

/**
 * Decides what may go. Pure (non-negotiable 9): no clock, no filesystem, no database — the survey,
 * the id set, and the instant are all handed in, so every rule above is testable against no disk.
 */
export function planConfigDirReap(input: ReapPlanInput): ReapPlan {
  const cutoffMs = input.now.getTime() - input.graceMs
  // Account ids are lowercase uuids, so a case variant is a name this router never minted. It is
  // still folded together with the live set rather than treated as unrelated: a directory that
  // *reads* as a live account's is one no sweep should be the first to gamble on.
  const live = new Set([...input.liveAccountIds].map((id) => id.toLowerCase()))

  const candidates: OrphanConfigDir[] = []
  let claimed = 0
  let young = 0
  let foreign = 0

  for (const entry of input.entries) {
    if (entry.accountId === null) {
      foreign += 1
      continue
    }
    if (live.has(entry.accountId.toLowerCase())) {
      claimed += 1
      continue
    }
    if (entry.changedAtMs >= cutoffMs) {
      young += 1
      continue
    }
    candidates.push({ ...entry, accountId: entry.accountId })
  }

  // Oldest first, so a backlog larger than one batch drains in a deterministic order rather than
  // whatever order the filesystem happened to enumerate.
  candidates.sort((a, b) => a.changedAtMs - b.changedAtMs)

  return {
    reap: candidates.slice(0, input.limit),
    claimed,
    young,
    foreign,
    remaining: candidates.length > input.limit,
  }
}

export interface ConfigDirReapDeps {
  readonly configDirs: Pick<AccountConfigDirs, "root" | "list" | "remove">
  readonly accounts: Pick<AccountRepository, "listIds">
  /** `RETENTION_ORPHAN_CONFIG_DIR_HOURS`, in milliseconds. Config, never a constant here. */
  readonly graceMs: number
  /** `CONFIG_DIR_REAP_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** `SWEEP_BATCH_SIZE`, counted in directories rather than rows. */
  readonly batchSize: number
}

export function createConfigDirReapTask(deps: ConfigDirReapDeps): ScheduledTask {
  return {
    name: "config_dir_reap",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      // Order is the invariant, not an implementation detail — see rule 1 in this file's header.
      const entries = await deps.configDirs.list()
      const liveAccountIds = new Set(await deps.accounts.listIds())

      const plan = planConfigDirReap({
        entries,
        liveAccountIds,
        now,
        graceMs: deps.graceMs,
        limit: deps.batchSize,
      })

      let removed = 0
      let stopped = false
      try {
        for (const orphan of plan.reap) {
          if (signal.aborted) {
            stopped = true
            break
          }
          await deps.configDirs.remove(orphan.accountId)
          removed += 1
          // One line per directory, at `warn`: this deletes credentials, and an orphan is rare
          // enough that "never logged" is the normal volume. An operator asking "where did that
          // account's login go" must be able to find the answer.
          logger.warn("orphaned claude config directory removed", {
            accountId: orphan.accountId,
            ageHours: Math.round((now.getTime() - orphan.changedAtMs) / HOUR_MS),
          })
        }
      } catch (error) {
        // Caught rather than thrown so the count survives: what was removed is gone whatever
        // happens next, and the runner redacts and truncates the full cause chain — unbounded
        // here — before it reaches the run row.
        return {
          outcome: "failed",
          itemsProcessed: removed,
          error: describeError(error, Number.POSITIVE_INFINITY),
        }
      }

      logger.info("config dir reap", {
        root: deps.configDirs.root,
        surveyed: entries.length,
        removed,
        claimed: plan.claimed,
        withinGrace: plan.young,
        foreign: plan.foreign,
      })

      return {
        outcome: stopped || plan.remaining ? "partial" : "success",
        itemsProcessed: removed,
      }
    },
  }
}

const HOUR_MS = 60 * 60 * 1_000
