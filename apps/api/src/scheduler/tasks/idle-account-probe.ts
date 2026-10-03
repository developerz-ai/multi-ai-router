import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { SdkUsageGaugeProbeOutcome, UpstreamFailureKind } from "../../providers"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { ScheduledTask, TaskOutcome } from "../types"
import { isCold, keepAlive, readUsage, type Tally, warm } from "./idle-account-warmth"

/**
 * Free CLI auth checks may recover credentials. Paid maintenance is separately opt-in,
 * restricted to active authoritative subjects with no open recovery generation, and
 * revalidated at the final transport admission boundary after all queue waits.
 * A keepalive warms an access token; it never extends a subscription's login lifetime.
 */
export const IDLE_PROBE_MODELS: Readonly<Record<string, string>> = {
  "anthropic-oauth": "claude-haiku-4-5-20251001",
  "anthropic-api": "claude-haiku-4-5-20251001",
  "openai-oauth": "gpt-5",
  "openai-api": "gpt-5",
  minimax: "MiniMax-M2",
  zai: "glm-4.6",
}

/**
 * What the sweep reads off one test. `message` is the test's own router-authored sentence and
 * `failureKind` its class — carried so a failed keepalive's log line says why, and so a spent
 * window (expected; a clock fixes it) is told apart from a turn that broke.
 */
export interface IdleProbeTestResult {
  readonly tested: boolean
  readonly outcome?: "ok" | "failed"
  readonly message?: string
  readonly failureKind?: UpstreamFailureKind
}

export interface IdleAccountProbeDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findIdle" | "readEligibleBackgroundAccount">
  /**
   * The billed half. Its own cooldown still applies, so an operator who just pressed "Test now" by
   * hand does not get a second charge from this task — the refusal comes back as `tested: false`
   * and is counted as a skip, not a failure.
   */
  readonly test: (
    accountId: string,
    model: string,
    expected: AccountRow,
  ) => Promise<IdleProbeTestResult>
  /**
   * The free half. Answers `null` for an account with no CLI-managed credential, so it is asked of
   * every account and only the subscriptions cost a subprocess. Absent means no CLI is available:
   * the auth question cannot be asked, and idle accounts go straight to the paid test.
   */
  readonly auth?: AccountAuthProbe
  /**
   * The turn-free usage read for one subscription account, run after its credential checks out
   * **and is warm**. Absent means the sweep leaves the gauge to the request path.
   */
  readonly usage?: (account: AccountRow) => Promise<SdkUsageGaugeProbeOutcome>
  /** Which model each provider is probed with. Absent for a provider means it is not probed. */
  readonly models: Readonly<Record<string, string>>
  /** `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** How long an account must have gone unused before it is worth spending a request on. */
  readonly idleAfterMs: number
  /** Idle accounts billed per tick. Each one spawns a subprocess, so this bounds memory, not just time. */
  readonly batchSize: number
  /** `IDLE_ACCOUNT_PROBE_PAID_TURN`. False means `test` is never called — see the module comment. */
  readonly paidTurn: boolean
  /**
   * Whether a `claude` subprocess spawned against this account right now would refresh its access
   * token — `CredentialFreshness.wouldRefresh`, the one definition of *cold* every spawn site
   * shares. Metadata only: one boolean, and nothing on the seam could hold a token (CLAUDE.md
   * non-negotiables 1 and 13). Absent means the sweep cannot tell warm from cold and never warms.
   */
  readonly cold?: (account: AccountRow) => Promise<boolean>
  /**
   * `CLAUDE_SDK_CREDENTIAL_KEEPALIVE`. False leaves a cold credential to warn and nothing else —
   * and, because a turn-free read is refused against it, un-gauged until a client's turn.
   */
  readonly warmCredentials: boolean
}

const ABORTED = "stopped between accounts by shutdown"

export function createIdleAccountProbeTask(deps: IdleAccountProbeDeps): ScheduledTask {
  return {
    name: "idle_account_probe",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }): Promise<TaskOutcome> => {
      const tally: Tally = {
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
      const loggedOut = new Set<string>()
      const processed = (): number => tally.checked + tally.probed

      try {
        // Every credential first, idle or not — see the module header for the outage this closes.
        if (deps.auth !== undefined) {
          const accounts = await deps.accounts.list({})
          for (const observed of accounts) {
            const account = Object.freeze({ ...observed })
            if (signal.aborted) return partial(logger, tally, processed())
            if (account.status === "disabled") continue
            const answer = await checkCredential(deps.auth, account, logger, tally)
            if (answer === "logged-out") loggedOut.add(account.id)
            if (answer !== "logged-in") continue
            if (
              (await deps.accounts.readEligibleBackgroundAccount(account.id, account)) === undefined
            ) {
              tally.skipped++
              continue
            }
            // The order is the fix: a real turn crosses the refresh and persists it; only then may
            // a turn-free read touch the directory. A cold account that could not be warmed is
            // left alone entirely — `openIdleQuery` would refuse it anyway.
            if (await isCold(deps, account, logger)) {
              const warmed = await warm(deps, account, logger, tally)
              // A spent window fails the *turn*, not the refresh: the process ran to completion,
              // so the credential may well be warm now — and a spent account's gauge is the one
              // an operator most wants read. Asked again rather than assumed.
              const usable =
                warmed === "ok" || (warmed === "spent" && !(await isCold(deps, account, logger)))
              if (!usable) continue
            }
            await readUsage(deps, account, logger, tally)
          }
        }

        if (!deps.paidTurn) {
          logger.info("idle account probe", { outcome: "success", ...tally, paidTurn: false })
          return { outcome: "success", itemsProcessed: processed() }
        }

        const before = new Date(now.getTime() - deps.idleAfterMs)
        const idle = await deps.accounts.findIdle({ before, limit: deps.batchSize })

        for (const observed of idle) {
          const account = Object.freeze({ ...observed })
          // Between accounts, never mid-turn: a shutdown must not orphan a `claude` subprocess.
          if (signal.aborted) return partial(logger, tally, processed())

          const model = deps.models[account.provider]
          if (model === undefined) {
            // A provider with no probe model configured is one this task has nothing safe to send.
            tally.skipped += 1
            continue
          }
          if (loggedOut.has(account.id)) {
            logger.warn("idle account needs re-authentication — not testing it", {
              accountId: account.id,
              provider: account.provider,
              lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
            })
            continue
          }

          await keepAlive(deps, account, model, logger, tally)
        }

        // A full batch means there may be more idle accounts than one tick bills: resumable, so
        // the next tick continues, and `partial` is what tells an operator it will.
        const outcome = idle.length >= deps.batchSize && idle.length > 0 ? "partial" : "success"
        logger.info("idle account probe", { outcome, ...tally, idle: idle.length })
        return { outcome, itemsProcessed: processed() }
      } catch (error) {
        // The sweep itself broke — a repository or a probe that threw — which is the one case an
        // operator should read as `failed`, with the cause on the run row. Unbounded here: the
        // runner redacts and truncates the full cause chain before it reaches the row.
        const reason = describeError(error, Number.POSITIVE_INFINITY)
        logger.error("idle account probe failed", { ...tally, error: reason })
        return { outcome: "failed", itemsProcessed: processed(), error: reason }
      }
    },
  }
}

/**
 * The free question, asked of one account. `null` from the probe is "nothing to say" — not a
 * CLI-managed credential, or the CLI could not answer — and is never read as logged out: marking
 * healthy accounts `needs_reauth` because a binary was missing is the bad trade
 * `login/contract.ts` warns about. Only an explicit `loggedIn: false` counts.
 */
async function checkCredential(
  auth: AccountAuthProbe,
  account: AccountRow,
  logger: Logger,
  tally: Tally,
): Promise<"logged-in" | "logged-out" | "unknown"> {
  const report = await auth.check(account)
  if (report === null) return "unknown"
  tally.checked += 1

  if (!report.loggedIn) {
    tally.loggedOut += 1
    // `warn`, once per tick per dead credential: a human has to act, and this line is how the
    // operator learns which account before a client does.
    logger.warn("account credential is logged out — needs re-authentication", {
      accountId: account.id,
      provider: account.provider,
      previousStatus: account.status,
      statusChangedTo: report.statusChangedTo,
    })
    return "logged-out"
  }

  if (report.statusChangedTo === "active") tally.reauthorized += 1
  logger.info("account credential checked", {
    accountId: account.id,
    provider: account.provider,
    loggedIn: true,
    statusChangedTo: report.statusChangedTo,
  })
  return "logged-in"
}

function partial(logger: Logger, tally: Tally, itemsProcessed: number): TaskOutcome {
  logger.info("idle account probe", { outcome: "partial", reason: ABORTED, ...tally })
  return { outcome: "partial", itemsProcessed }
}
