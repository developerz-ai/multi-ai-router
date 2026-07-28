import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { AccountAuthProbe } from "../../services/health/claudeAuthProbe"
import type { ScheduledTask } from "../types"

/**
 * Keeps an **unused** account from dying quietly.
 *
 * The failure this exists to prevent is specific and invisible until it bites. A Claude
 * subscription's tokens live in its own `CLAUDE_CONFIG_DIR` and are refreshed by the Agent SDK —
 * the router never touches them (non-negotiable 1). But the SDK only refreshes them **when it
 * runs**. The access token lasts hours and the refresh token weeks, so a subscription nobody has
 * routed to for a month is not idle, it is *expired*: the first request after that silence fails,
 * and the operator discovers it at exactly the moment they needed the account.
 *
 * So this task spends one real request on an account traffic has forgotten, which is the whole
 * point — the request *is* the refresh. Nothing else here can produce one: `recheck` deliberately
 * sends nothing, and the quota floor only expires stale readings.
 *
 * **The free check runs first, and a dead credential ends the run for that account.** Asking the
 * `claude` CLI whether it is still logged in costs nothing — no provider is contacted, no turn is
 * spent — and it is the one question worth asking before paying for anything. An account that
 * answers "logged out" is marked `needs_reauth` and **skipped**: the test would fail, it would fail
 * for a reason a human already has to fix, and billing a turn to re-learn that is spending money to
 * confirm a fact we hold. That ordering is the difference between a keepalive and a slow leak.
 *
 * **Testing an account counts as using it.** The test writes a usage record, whose drain stamps
 * `last_used_at` (`services/usage/fromEnv.ts`), so a probed account stops being idle and is not
 * revisited until the threshold passes again. The task therefore runs daily but each account is
 * touched about once per idle window — the cadence is the *threshold*, not the interval, and that
 * is what keeps a fleet of subscriptions from being billed a turn a day each.
 *
 * **Bounded, idempotent, resumable**, like every task here: one batch per tick, ordered
 * most-neglected first, abort checked between accounts so a shutdown never lands mid-turn. Running
 * twice is harmless — the second run finds the accounts the first one stamped and skips them.
 *
 * **`disabled` is excluded** by the repository query: it is the operator's own switch, and spending
 * money to keep alive an account they turned off is not this task's call. Every other status is
 * included deliberately — an `exhausted` or `cooling_down` account still holds a credential that
 * expires on its own schedule, and being out of credits today says nothing about wanting to be
 * logged out next month.
 */

/**
 * Which model each provider's keepalive turn asks for.
 *
 * **This is the one place the router names a model without a client asking**, and it is worth being
 * uncomfortable about: non-negotiable 4 says the client picks the model and the router never
 * substitutes one. The rule holds — nothing here touches a client request. A keepalive has no
 * client to ask, so it either names a model or cannot exist, and the alternative to naming one is a
 * subscription that silently expires.
 *
 * Kept deliberately small and explicit rather than clever: a provider absent from this map is
 * **not probed at all**, which is the honest failure. Guessing a model id for an unknown provider
 * would spend a request to receive a 400 and learn nothing about the credential.
 *
 * Cheap, current, widely-available ids — the turn's content is irrelevant, only that it completes.
 */
export const IDLE_PROBE_MODELS: Readonly<Record<string, string>> = {
  // The motivating case: these are the accounts whose tokens expire unattended.
  "anthropic-oauth": "claude-sonnet-4-5-20250929",
  "anthropic-api": "claude-sonnet-4-5-20250929",
  "openai-oauth": "gpt-5",
  "openai-api": "gpt-5",
  minimax: "MiniMax-M2",
  zai: "glm-4.6",
  kimi: "k2",
}

export interface IdleAccountProbeDeps {
  readonly accounts: Pick<AccountRepository, "findIdle" | "updateStatusWhen">
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
   * The free half, for Claude subscriptions only. Absent means no CLI is available, in which case
   * the auth question cannot be asked and the account is probed on the paid path alone — reported,
   * never silently skipped.
   */
  readonly auth?: AccountAuthProbe
  /** Which model each provider is probed with. Absent for a provider means it is not probed. */
  readonly models: Readonly<Record<string, string>>
  /** `IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** How long an account must have gone unused before it is worth spending a request on. */
  readonly idleAfterMs: number
  /** Accounts probed per tick. Each one may spawn a subprocess, so this bounds memory, not just time. */
  readonly batchSize: number
}

export function createIdleAccountProbeTask(deps: IdleAccountProbeDeps): ScheduledTask {
  return {
    name: "idle_account_probe",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const before = new Date(now.getTime() - deps.idleAfterMs)
      const idle = await deps.accounts.findIdle({ before, limit: deps.batchSize })
      if (idle.length === 0) {
        logger.info("idle account probe", { outcome: "success", idle: 0 })
        return { outcome: "success", itemsProcessed: 0 }
      }

      const tally = { probed: 0, refreshed: 0, failed: 0, reauth: 0, skipped: 0 }

      for (const account of idle) {
        // Between accounts, never mid-turn: a shutdown must not orphan a `claude` subprocess, and
        // each account's outcome is independently complete.
        if (signal.aborted) {
          logger.info("idle account probe", { outcome: "partial", ...tally })
          return { outcome: "partial", itemsProcessed: tally.probed }
        }

        const model = deps.models[account.provider]
        if (model === undefined) {
          // Not a failure: a provider with no probe model configured is one this task has nothing
          // safe to send. Counted so the number is visible rather than inferred from a gap.
          tally.skipped += 1
          continue
        }

        if (await isLoggedOut(deps, account)) {
          tally.reauth += 1
          logger.warn("idle account needs re-authentication — not testing it", {
            accountId: account.id,
            provider: account.provider,
            lastUsedAt: account.lastUsedAt?.toISOString() ?? null,
          })
          continue
        }

        tally.probed += 1
        const result = await deps.test(account.id, model)
        if (!result.tested) {
          // Its own cooldown declined — an operator tested it moments ago. Nothing was billed.
          tally.skipped += 1
          tally.probed -= 1
          continue
        }
        if (result.outcome === "ok") {
          tally.refreshed += 1
          continue
        }

        tally.failed += 1
        // Deliberately not a status write. The test already fed the breaker and the classification
        // it produced (`cooling_down`, `exhausted`, …) is a better answer than anything this task
        // could infer from a boolean — see `services/accounts/test-now.ts`.
        logger.warn("idle account failed its keepalive test", {
          accountId: account.id,
          provider: account.provider,
        })
      }

      // `partial` when something failed: the run did its work, but an operator looking at
      // `ScheduledTaskRun` should see that not every account came back healthy.
      const outcome = tally.failed > 0 || tally.reauth > 0 ? "partial" : "success"
      logger.info("idle account probe", { outcome, ...tally, idle: idle.length })
      return { outcome, itemsProcessed: tally.probed }
    },
  }
}

/**
 * Whether this account's credential has already died — asked only where it can be asked for free.
 *
 * `AccountAuthProbe` reads the credential file the `claude` CLI wrote and contacts nobody, and it
 * writes `needs_reauth` itself when the answer is "logged out" (`services/health/claudeAuthProbe.ts`
 * owns that transition, including the fact that it never overrides `disabled`). This function only
 * decides whether the paid test follows.
 *
 * A probe that cannot answer — no CLI, an unreadable directory — is **not** treated as logged out:
 * marking healthy accounts `needs_reauth` because a binary was missing is the exact bad trade
 * `login/contract.ts` warns about, so an indefinite answer falls through to the paid test, which
 * gives a real one.
 */
async function isLoggedOut(
  deps: Pick<IdleAccountProbeDeps, "auth">,
  account: AccountRow,
): Promise<boolean> {
  if (deps.auth === undefined) return false
  // `null` is "nothing to say" — not a CLI-managed credential, or the CLI could not answer. Only
  // an explicit `loggedIn: false` stops the paid test.
  const report = await deps.auth.check(account)
  return report?.loggedIn === false
}
