import { describeError } from "@multi-ai-router/core"
import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import type { RateLimitSignal, SdkUsageGaugeProbeOutcome } from "../../providers"
import { UpstreamAdmissionRefused } from "../../providers/upstream-admission"
import { describeProvider } from "../../services/accounts/providers"
import type { HealthStore } from "../../services/dataplane"
import { accountHealthFacts } from "../../services/dataplane/health-observation"
import { probeModel, type RecoveryProbeSend } from "../../services/dataplane/recovery-probe"
import type { RoutableAccount } from "../../services/dataplane/types"
import type { AccountSnapshot } from "../../services/routing"
import { cooldownRecheckDue, readingReopened } from "../../services/routing/cooldown-recheck"
import type { ScheduledTask } from "../types"

/**
 * The look an account on a long cooldown gets while its stated reset is still days away. Providers
 * do reset windows early, and until this task a weekly window meant nothing checked until it ended.
 *
 * **The cheapest honest signal each transport has.** A Claude subscription answers a turn-free usage
 * read, so it is never sent a request: a real turn would bill usage, and the window it asks about is
 * the reason the account is out. Every HTTP account has no such read, so it gets one minimal real
 * request per interval through the admin plane's "Test now" transport.
 *
 * **A recheck only ever ends a cooldown.** A still-limited answer keeps its window readings and
 * drops its verdict: no breaker transition runs, so the stated reset, its source and the failure
 * streak all stand. Folded as a verdict, a reset-less `429` would replace a provider's instant with
 * our backoff arithmetic, once an hour, for as long as the window lasted.
 *
 * **Not the recovery permit.** That gate deliberately refuses a clock the provider reported
 * (`routing/filter.ts`, `recoveryAwaitsProbe`), because it retries every cycle: prod, 2026-10-06,
 * a certain-429 probe every cooldown for days. This is the same probe on an hourly clock instead,
 * with a start guard of its own that admits `cooling_down` and refuses everything else.
 *
 * **What it cannot see.** A cooldown lives in the memory of the replica that took the `429`, and
 * this task runs on whichever replica won the advisory lock. Spent windows are durable and seen from
 * anywhere; a breaker-only cooldown on another replica runs to its own reset.
 */

export interface CooldownRecheckPorts {
  /** The warm catalog. Selection is a read of memory, not of Postgres. */
  readonly accounts: () => readonly RoutableAccount[]
  /** The account with live health overlaid, so a verdict held only in memory counts. */
  readonly snapshot: (accountId: string) => AccountSnapshot | undefined
  readonly rows: Pick<AccountRepository, "findById">
  readonly health: Pick<HealthStore, "captureAttempt" | "recordSuccess" | "applyRateLimit">
  /** The real-request half: `recoveryProbeSender` over the admin plane's "Test now". */
  readonly send: RecoveryProbeSend
  /** Final admission, built per account: `cooling_down` passes, every standing block refuses. */
  readonly startGuard: (row: AccountRow) => () => Promise<void>
  /** The turn-free half. Absent where no CLI is available: subscriptions wait for their reset. */
  readonly usage?: (row: AccountRow) => Promise<SdkUsageGaugeProbeOutcome>
  /** Each provider's fallback probe model, for accounts declaring none. */
  readonly models: Readonly<Record<string, string>>
  readonly quotaSpentThreshold: number
}

export interface CooldownRecheckDeps extends CooldownRecheckPorts {
  /** `COOLDOWN_RECHECK_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
  /** Accounts looked at per tick. Each may bill a request or spawn a subprocess. */
  readonly batchSize: number
}

type Verdict = "reopened" | "still-cooling" | "failed" | "skipped"

/** Nothing wired means no task, like every other sweep with nothing to spend. */
export function createCooldownRecheckTasks(
  ports: CooldownRecheckPorts | undefined,
  options: Pick<CooldownRecheckDeps, "intervalMs" | "batchSize">,
): readonly ScheduledTask[] {
  return ports === undefined ? [] : [createCooldownRecheckTask({ ...ports, ...options })]
}

export function createCooldownRecheckTask(deps: CooldownRecheckDeps): ScheduledTask {
  // Per account, so bounded by the account count: oldest look first, or a pool larger than the
  // batch would recheck the same few accounts forever.
  const lastLook = new Map<string, number>()

  return {
    name: "cooldown_recheck",
    intervalMs: deps.intervalMs,

    run: async ({ now, logger, signal }) => {
      const accounts = deps.accounts()
      const known = new Set(accounts.map((account) => account.id))
      for (const id of lastLook.keys()) if (!known.has(id)) lastLook.delete(id)

      const due = accounts
        .filter((account) => {
          const live = deps.snapshot(account.id)
          return (
            live !== undefined &&
            cooldownRecheckDue(live, now, deps.intervalMs, deps.quotaSpentThreshold)
          )
        })
        .sort((a, b) => (lastLook.get(a.id) ?? 0) - (lastLook.get(b.id) ?? 0))

      const tally: Record<Verdict, number> = {
        reopened: 0,
        "still-cooling": 0,
        failed: 0,
        skipped: 0,
      }
      const looked = (): number => tally.reopened + tally["still-cooling"] + tally.failed
      for (const account of due.slice(0, deps.batchSize)) {
        if (signal.aborted) {
          logger.info("cooldown recheck", { outcome: "partial", due: due.length, ...tally })
          return { outcome: "partial", itemsProcessed: looked() }
        }
        lastLook.set(account.id, now.getTime())
        tally[await recheck(deps, account, now, logger)] += 1
      }

      const outcome = due.length > deps.batchSize ? "partial" : "success"
      logger.info("cooldown recheck", { outcome, due: due.length, ...tally })
      return { outcome, itemsProcessed: looked() }
    },
  }
}

async function recheck(
  deps: CooldownRecheckDeps,
  account: RoutableAccount,
  now: Date,
  logger: Logger,
): Promise<Verdict> {
  const fields = { accountId: account.id, provider: account.driver.provider }
  try {
    const before = deps.snapshot(account.id)
    const row = await deps.rows.findById(account.id)
    if (before === undefined || row === undefined) return "skipped"
    const verdict =
      describeProvider(row.provider).transport === "agent-sdk"
        ? await byUsageRead(deps, account, row, before, now)
        : await byRequest(deps, account, row, before)
    logger.info("account rechecked on cooldown", { ...fields, verdict })
    return verdict
  } catch (error) {
    if (error instanceof UpstreamAdmissionRefused) return "skipped"
    logger.warn("cooldown recheck failed", {
      ...fields,
      error: describeError(error, Number.POSITIVE_INFINITY),
    })
    return "failed"
  }
}

async function byUsageRead(
  deps: CooldownRecheckDeps,
  account: RoutableAccount,
  row: AccountRow,
  before: AccountSnapshot,
  now: Date,
): Promise<Verdict> {
  if (deps.usage === undefined) return "skipped"
  const observation = deps.health.captureAttempt(account.id, accountHealthFacts(account))
  if ((await deps.usage(row)) !== "read") return "skipped"
  const after = deps.snapshot(account.id)
  if (after === undefined || !readingReopened(before, after, now, deps.quotaSpentThreshold))
    return "still-cooling"
  deps.health.recordSuccess(account.id, observation)
  return "reopened"
}

async function byRequest(
  deps: CooldownRecheckDeps,
  account: RoutableAccount,
  row: AccountRow,
  before: AccountSnapshot,
): Promise<Verdict> {
  const choice = probeModel(before, deps.models)
  if (choice === undefined) return "skipped"
  const observation = deps.health.captureAttempt(account.id, accountHealthFacts(account))
  const seen: { reading?: RateLimitSignal } = {}
  const result = await deps.send({
    accountId: account.id,
    model: choice.model,
    startGuard: deps.startGuard(row),
    rateLimitSink: (signal) => {
      seen.reading = signal
    },
    trigger: "cooldown_recheck",
  })
  if (result.kind !== "answered") return "skipped"
  const { reading } = seen
  const fold = (signal: RateLimitSignal): void =>
    deps.health.applyRateLimit(account.id, signal, new Date(), observation)
  if (result.ok) {
    deps.health.recordSuccess(account.id, observation)
    if (reading !== undefined) fold(reading)
    return "reopened"
  }
  if (reading !== undefined) fold({ ...reading, limited: false })
  return result.failureKind === "rate-limited" ? "still-cooling" : "failed"
}
