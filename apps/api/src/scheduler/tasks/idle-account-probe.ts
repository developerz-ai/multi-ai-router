import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { SdkUsageGaugeProbeOutcome } from "../../providers"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { ScheduledTask, TaskOutcome } from "../types"
import { isCold, keepAlive, readUsage, type Tally, warm } from "./idle-account-warmth"

/**
 * The daily credential sweep: a free logged-in check over **every** account that holds a CLI-managed
 * credential, then one real request for the accounts traffic has forgotten.
 *
 * **What a Claude subscription's refresh token actually does — and does not.** Its access token
 * lasts hours and is refreshed by the Agent SDK when a `query()` runs. Its refresh token **hard-expires
 * about 30 days after login, however much the account is used in between** — observed in
 * production on every account (`refreshTokenExpiresAt` = login + ~30 d, on accounts that served
 * traffic daily). Nothing this router does can move that date: not traffic, not this sweep, not
 * "Re-check now". Only a re-login can. So the billed turn below keeps an *unused* account's access
 * token warm; it is not, and never was, a way to keep a subscription alive past its month
 * (docs/idea/11-anthropic-agent-sdk.md §3, "Credential lifecycle per Account").
 *
 * **The free check runs over every account, not only idle ones.** The failure this closes was
 * observed on 2026-09-05: three subscriptions whose refresh tokens had expired served traffic
 * daily, so they were never idle and never checked, and sat `active` in the console for a week
 * while every request through them answered `502`. `claude auth status` reads the credential file
 * and contacts nobody, so asking it of every account once a day costs a subprocess each and nothing
 * else — and an expired subscription flips to `needs_reauth` within a day instead of on the next
 * client's failed request. The probe (`services/health/claudeAuthProbe.ts`) owns that transition,
 * in both directions.
 *
 * **The billed half is opt-in (`IDLE_ACCOUNT_PROBE_PAID_TURN`, default off), and stays bounded to
 * idle accounts when it is on.** Checking whether a subscription is alive must never spend usage:
 * a turn refreshes only the *access* token, which the cliff above does not care about, so the
 * operator was paying for a check that could not achieve its aim — and saw usage move on freshly
 * reconnected accounts. With the flag off the sweep bills nothing on any provider. With it on, a
 * dead credential still ends the run for that account: the test would fail, for a reason a human
 * already has to fix, and billing a turn to re-learn that is spending money to confirm a fact we
 * hold. Testing an account counts as using it, so each account is billed about once per idle
 * window, not once per tick.
 *
 * **The free half also reads the usage gauge** for every logged-in subscription, through a
 * turn-free query (`providers/claude-sdk/usage-gauge-probe.ts`): the console's per-window
 * percentages for an account nothing routed to today would otherwise stay stale until traffic
 * arrived. One subprocess per account per sweep, no prompt, nothing billed.
 *
 * **A cold credential is warmed with a real turn *before* anything turn-free touches it.** The
 * CLI refreshes the access token at startup once it is expired or inside its own five-minute lead,
 * and persists the rotated refresh token only after the token endpoint answers; a turn-free query
 * is ended the moment its handshake is read, before that write, and the refresh token on disk is
 * then spent — the next process to present it is told `invalid_grant` and the CLI blanks the
 * credential. That, and not a race or an upstream policy, is what deauthenticated six of six
 * production subscriptions on 2026-09-06/07 (docs/idea/11-anthropic-agent-sdk.md §3). So the order
 * per account is fixed: the free check, then — if the token is cold — one small real turn, which
 * runs to completion and persists the refresh, and only then the gauge. `openIdleQuery` refuses a
 * cold credential on its own as well; the sweep simply does not ask. With the keepalive off, or
 * its per-tick batch full, a cold account keeps its old gauge and its old catalog until a client's
 * turn refreshes it, and the sweep says so.
 *
 * **Outcomes are the sweep's, not the accounts'.** An account correctly parked `needs_reauth` is
 * the sweep doing its job — `success`, with a `warn` line naming the account. `partial` means the
 * sweep was cut short: a shutdown between accounts, or an idle batch larger than one tick takes.
 * `failed` means the sweep itself threw, and says why. Before this distinction every logged-out
 * account produced a silent `partial` with an empty error, daily, for weeks.
 *
 * **`disabled` is excluded** from both halves: it is the operator's own switch.
 */

/**
 * Which model each provider's keepalive turn asks for.
 *
 * **This is the one place the router names a model without a client asking**, and it is worth being
 * uncomfortable about: non-negotiable 4 says the client picks the model and the router never
 * substitutes one. The rule holds — nothing here touches a client request. A keepalive has no
 * client to ask, so it either names a model or cannot exist. A provider absent from this map is
 * **not probed at all**, which is the honest failure.
 */
export const IDLE_PROBE_MODELS: Readonly<Record<string, string>> = {
  "anthropic-oauth": "claude-sonnet-4-5-20250929",
  "anthropic-api": "claude-sonnet-4-5-20250929",
  "openai-oauth": "gpt-5",
  "openai-api": "gpt-5",
  minimax: "MiniMax-M2",
  zai: "glm-4.6",
  kimi: "k2",
}

export interface IdleAccountProbeDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findIdle" | "updateStatusWhen">
  /**
   * The billed half. Its own cooldown still applies, so an operator who just pressed "Test now" by
   * hand does not get a second charge from this task — the refusal comes back as `tested: false`
   * and is counted as a skip, not a failure.
   */
  readonly test: (
    accountId: string,
    model: string,
  ) => Promise<{ readonly tested: boolean; readonly outcome?: "ok" | "failed" }>
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
          for (const account of accounts) {
            if (signal.aborted) return partial(logger, tally, processed())
            if (account.status === "disabled") continue
            const answer = await checkCredential(deps.auth, account, logger, tally)
            if (answer === "logged-out") loggedOut.add(account.id)
            if (answer !== "logged-in") continue
            // The order is the fix: a real turn crosses the refresh and persists it; only then may
            // a turn-free read touch the directory. A cold account that could not be warmed is
            // left alone entirely — `openIdleQuery` would refuse it anyway.
            if (await isCold(deps, account, logger)) {
              if (!(await warm(deps, account, logger, tally))) continue
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

        for (const account of idle) {
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
