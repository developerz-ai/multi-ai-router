import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { CredentialMetadata } from "../../providers/claude-sdk/credential-metadata"
import { describeProvider } from "../../services/accounts/providers"
import type { ScheduledTask, TaskOutcome } from "../types"
import {
  describeRotation,
  type KeepaliveAttempt,
  type KeepaliveCandidate,
  type KeepalivePolicy,
  selectKeepaliveTargets,
} from "./credential-keepalive-selection"
import type { IdleAccountProbeDeps } from "./idle-account-probe"
import { type KeepAliveResult, keepAlive, type Tally } from "./idle-account-warmth"

/**
 * The credential keepalive, on the cadence the **access** token needs.
 *
 * `idle_account_probe` already spends one small real turn on a cold subscription — but it ticks
 * every six hours against a token that lives ~8 h and is refreshed by the CLI only inside the last
 * five minutes. So in practice it found every idle token already *expired*, hours late, and the
 * hourly catalog sweep and the gauge read skipped the account in between ("left for a real turn").
 * This task is that same keepalive (`keepAlive`: background admission, then the admin plane's own
 * "Test now", sharing its per-account cooldown and audit kind) run every few minutes, against only
 * the accounts whose token the CLI would refresh *right now*. It is not a refresh timer of ours: it
 * reads timestamps, and when one says the CLI's window is open it gives the CLI a turn to refresh
 * inside, exactly as a client's request would (CLAUDE.md non-negotiables 1 and 13).
 *
 * Single-flighted per account by the test service: it records the account's turn before spawning,
 * so a second keepalive — this task's next tick, or the six-hourly sweep — is declined, not run.
 * A replica that loses this task's advisory lock skips the tick; the replica holding it does all.
 *
 * After each turn the credential metadata is read again and one line says what happened, in
 * timestamps: refreshed or not, and — the question nobody has answered yet — whether a rotation
 * moved `refreshTokenExpiresAt`.
 */

export interface CredentialKeepaliveDeps {
  readonly accounts: Pick<AccountRepository, "list" | "readEligibleBackgroundAccount">
  /** Credential metadata under this account's config directory. Never a token. */
  readonly readMetadata: (account: AccountRow) => Promise<CredentialMetadata>
  readonly test: IdleAccountProbeDeps["test"]
  readonly models: Readonly<Record<string, string>>
  readonly policy: KeepalivePolicy
  /** `CLAUDE_SDK_CREDENTIAL_KEEPALIVE_INTERVAL_SECONDS`, in ms. The runner jitters it. */
  readonly intervalMs: number
}

export function createCredentialKeepaliveTask(deps: CredentialKeepaliveDeps): ScheduledTask {
  // Per replica, deliberately: a backoff entry only stops this replica re-billing a turn that did
  // not refresh. Another replica winning the lock may spend one more — bounded, and logged.
  const attempts = new Map<string, KeepaliveAttempt>()

  return {
    name: "credential_keepalive",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      try {
        const accounts = await deps.accounts.list({})
        const candidates: KeepaliveCandidate[] = []
        for (const account of accounts) {
          if (!describeProvider(account.provider).requiresConfigDir) continue
          if (account.status !== "active") continue
          const metadata = await readQuietly(deps, account, logger)
          if (metadata !== null)
            candidates.push({ account: Object.freeze({ ...account }), metadata })
        }

        const selection = selectKeepaliveTargets(candidates, now.getTime(), deps.policy, attempts)
        if (selection.due.length === 0) return { outcome: "success", itemsProcessed: 0 }

        const tally = emptyTally()
        // Concurrently: a tick that ran its turns one after another could stretch the gap to the
        // next tick past the CLI's lead. The SDK semaphore still bounds the subprocesses.
        const results = await Promise.all(
          selection.due.map((candidate) =>
            signal.aborted
              ? Promise.resolve(false)
              : keepOne(deps, candidate, now, attempts, logger, tally),
          ),
        )
        const warmed = results.filter(Boolean).length
        const outcome = selection.deferred > 0 || signal.aborted ? "partial" : "success"
        logger.info("credential keepalive", {
          outcome,
          due: selection.due.length,
          deferred: selection.deferred,
          backingOff: selection.backingOff,
          refreshed: warmed,
          probed: tally.probed,
          failed: tally.failed,
          skipped: tally.skipped,
        })
        return { outcome, itemsProcessed: tally.probed }
      } catch (error) {
        const reason = describeError(error, Number.POSITIVE_INFINITY)
        logger.error("credential keepalive failed", { error: reason })
        return { outcome: "failed", itemsProcessed: 0, error: reason }
      }
    },
  }
}

/** One account's turn and its before/after line. True when the CLI refreshed. */
async function keepOne(
  deps: CredentialKeepaliveDeps,
  candidate: KeepaliveCandidate,
  now: Date,
  attempts: Map<string, KeepaliveAttempt>,
  logger: Logger,
  tally: Tally,
): Promise<boolean> {
  const { account, metadata: before } = candidate
  const model = deps.models[account.provider]
  if (model === undefined || before.accessTokenExpiresAt === null) return false

  const result: KeepAliveResult = await keepAlive(deps, account, model, logger, tally)
  // Nothing was spawned — not eligible right now, or a turn is already in flight. No backoff: a
  // turn that never ran says nothing about whether the next one would refresh.
  if (result === "skipped") return false
  attempts.set(account.id, {
    atMs: now.getTime(),
    accessTokenExpiresAtMs: before.accessTokenExpiresAt.getTime(),
  })

  const after = await readQuietly(deps, account, logger)
  if (after === null) return false
  const rotation = describeRotation(before, after)
  const fields = { accountId: account.id, provider: account.provider, turn: result, ...rotation }
  if (rotation.refreshed) {
    attempts.delete(account.id)
    logger.info("claude credential refreshed by keepalive", fields)
    return true
  }
  // `warn`: the CLI was given its window and did not use it. Backed off for the retry interval.
  logger.warn("claude keepalive turn did not refresh the access token", {
    ...fields,
    hasTokens: after.hasTokens,
  })
  return false
}

/** Unreadable is unknown — logged, never cold. The message names a path or errno at most. */
async function readQuietly(
  deps: Pick<CredentialKeepaliveDeps, "readMetadata">,
  account: AccountRow,
  logger: Logger,
): Promise<CredentialMetadata | null> {
  try {
    return await deps.readMetadata(account)
  } catch (error) {
    logger.warn("credential keepalive: metadata unreadable", {
      accountId: account.id,
      reason: describeError(error, 200),
    })
    return null
  }
}

function emptyTally(): Tally {
  return {
    checked: 0,
    loggedOut: 0,
    reauthorized: 0,
    gauged: 0,
    probed: 0,
    spent: 0,
    warmed: 0,
    cold: 0,
    refreshed: 0,
    failed: 0,
    skipped: 0,
  }
}
