import type { AccountRepository, AccountRow, RecoveryRepository } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, notFound, ok } from "../admin/result"
import type { AccountAuthProbe, ClaudeAuthReport } from "../health/claudeAuthProbe"
import {
  type AccountRecoveryView,
  type RecoveryPresentationFacts,
  toRecoveryView,
} from "./recovery-view"

export interface RecheckResult {
  readonly accountId: string
  readonly lastCheckedAt: string | null
  readonly nextAllowedAt: string
  /** A new durable request was accepted; this does not report provider health. */
  readonly checkInProgress?: boolean
  readonly rechecked: boolean
  readonly recovery?: AccountRecoveryView
  readonly clearedStatus?: "exhausted"
  readonly auth?: ClaudeAuthReport
}
/**
 * Who pressed the button, recorded on the audit row: the operator, or `exhausted_recheck` — the
 * bounded re-test an `exhausted` account gets on a clock (`scheduler/tasks/exhausted-retest.ts`).
 */
export type RecheckSource = "operator_recovery" | "exhausted_recheck"

export interface RecheckService {
  recheck(accountId: string, source?: RecheckSource): Promise<AdminResult<RecheckResult>>
  recheckAll(): Promise<AdminResult<readonly RecheckResult[]>>
}
/** Runtime's atomic repository supplies database time and durable cooldown. */
export interface OperatorRecoveryRepository {
  reserveOperatorCheck(input: Parameters<RecoveryRepository["reserveOperatorCheck"]>[0]): Promise<
    | { kind: "acquired"; account: AccountRow; claimToken: string; leaseUntil: Date }
    | {
        kind: "busy" | "cooldown"
        account: AccountRow
        recovery?: RecoveryPresentationFacts & { requestedAt: Date }
        retryAt: Date
      }
    | undefined
  >
  finalizeOperatorCheck(input: Parameters<RecoveryRepository["finalizeOperatorCheck"]>[0]): Promise<
    | {
        kind: "committed"
        result: NonNullable<
          Awaited<ReturnType<OperatorRecoveryRepository["beginOperatorRecovery"]>>
        >
      }
    | {
        kind: "refused"
        checkInProgress?: boolean
        account: AccountRow
        recovery?: RecoveryPresentationFacts & { requestedAt: Date }
        retryAt: Date
      }
    | undefined
  >
  releaseOperatorCheck: RecoveryRepository["releaseOperatorCheck"]
  readOperatorCooldown(
    accountId: string,
  ): ReturnType<OperatorRecoveryRepository["beginOperatorRecovery"]>
  beginOperatorRecovery(input: Parameters<RecoveryRepository["beginOperatorRecovery"]>[0]): Promise<
    | {
        account: AccountRow
        recovery: RecoveryPresentationFacts & {
          readonly requestedAt: Date
        }
        rechecked: boolean
        clearedStatus: "exhausted" | null
      }
    | undefined
  >
}
export interface RecheckServiceDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findById">
  readonly auth?: AccountAuthProbe
  readonly recovery: OperatorRecoveryRepository
  readonly audit: AuditRecorder
  readonly refreshCatalog: () => Promise<void>
  /** Synchronous off-path scheduling; never blocks on issuer or exposes the permit. */
  readonly onRecoveryRequested?: (accountId: string) => void
  /** A committed re-check of a `needs_reauth` account: its refresh gets one more try, off-path. */
  readonly onParkedRecheck?: (accountId: string) => void
  /**
   * Whether nothing holds this account out of rotation right now (`liveHealthCheck`). Such a
   * re-check publishes a settled generation: a pending one would gate every request but the one
   * permit holder behind a probe the account does not need (plan 101, 03.1). Absent, every re-check
   * publishes a probe — the behaviour before this option existed.
   */
  readonly isLiveHealthy?: (accountId: string) => boolean
  /** How many accounts "Re-check all" commits at once (`ACCOUNT_RECHECK_ALL_CONCURRENCY`). */
  readonly recheckAllConcurrency?: number
  readonly operatorCheckLeaseMs?: number
  readonly cooldownSeconds: number
}

type Committed = NonNullable<
  Awaited<ReturnType<OperatorRecoveryRepository["beginOperatorRecovery"]>>
>

/** A re-check split at its durable commit: publishing it needs the catalog installed first. */
type CommitPhase =
  | { readonly kind: "done"; readonly result: AdminResult<RecheckResult> }
  | {
      readonly kind: "committed"
      readonly accountId: string
      readonly source: RecheckSource
      readonly committed: Committed
      readonly auth: ClaudeAuthReport | undefined
    }

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  const commit = async (accountId: string, source: RecheckSource): Promise<CommitPhase> => {
    const done = (result: AdminResult<RecheckResult>): CommitPhase => ({ kind: "done", result })
    const claimToken = crypto.randomUUID()
    const claim = await deps.recovery.reserveOperatorCheck({
      accountId,
      claimToken,
      leaseMs: deps.operatorCheckLeaseMs ?? 30_000,
    })
    if (claim === undefined) return done(notFound("No account has that id"))
    if (claim.kind !== "acquired") return done(ok(refusedView(accountId, claim)))
    const original = claim.account
    try {
      // No database lock crosses the CLI call; its token fences post-lease authentication mutations.
      const auth = (await deps.auth?.check(original, claimToken)) ?? undefined
      const finalized = await deps.recovery.finalizeOperatorCheck({
        accountId,
        claimToken,
        generationCandidate: crypto.randomUUID(),
        cooldownMs: deps.cooldownSeconds * 1_000,
        ...(deps.isLiveHealthy?.(accountId) === true ? { settled: true } : {}),
        ...(auth?.loggedIn === false
          ? {
              negativeAuthObservation: {
                lifecycleVersion: original.lifecycleVersion,
                authMaterial: original.authMaterial,
                loggedIn: false as const,
              },
            }
          : {}),
      })
      if (finalized === undefined) return done(notFound("No account has that id"))
      if (finalized.kind === "refused") return done(ok(refusedView(accountId, finalized)))
      return { kind: "committed", accountId, source, committed: finalized.result, auth }
    } finally {
      await deps.recovery.releaseOperatorCheck({ accountId, claimToken })
    }
  }

  // Runs only after the committed generation is installed locally (`refreshCatalog`).
  const publish = async (
    phase: Extract<CommitPhase, { kind: "committed" }>,
  ): Promise<AdminResult<RecheckResult>> => {
    const { accountId, committed, auth } = phase
    if (committed.recovery.state === "pending") deps.onRecoveryRequested?.(accountId)
    if (committed.rechecked) {
      // A committed pending restriction must reach local routing even if audit later fails.
      await deps.audit.record({
        kind: AUDIT_KINDS.accountRechecked,
        subjectType: AUDIT_SUBJECTS.account,
        subjectId: accountId,
        detail: {
          provider: committed.account.provider,
          source: phase.source,
          ...(committed.clearedStatus === null ? {} : { clearedStatus: committed.clearedStatus }),
          ...(auth === undefined
            ? {}
            : { loggedIn: auth.loggedIn, statusChangedTo: auth.statusChangedTo }),
        },
      })
      if (committed.account.status === "needs_reauth") deps.onParkedRecheck?.(accountId)
    }
    return ok({ ...recheckView(accountId, committed), ...(auth === undefined ? {} : { auth }) })
  }

  const attempt = async (
    accountId: string,
    source: RecheckSource,
  ): Promise<AdminResult<RecheckResult>> => {
    const phase = await commit(accountId, source)
    if (phase.kind === "done") return phase.result
    // Our reserved authentication check can publish a recovery even when finalization joins its cooldown.
    await deps.refreshCatalog()
    return publish(phase)
  }
  const flights = new Map<string, Promise<AdminResult<RecheckResult>>>()
  const recheck = (
    accountId: string,
    source: RecheckSource = "operator_recovery",
  ): Promise<AdminResult<RecheckResult>> => {
    const held = flights.get(accountId)
    if (held !== undefined) return held
    const flight = attempt(accountId, source).finally(() => {
      if (flights.get(accountId) === flight) flights.delete(accountId)
    })
    flights.set(accountId, flight)
    return flight
  }

  // Commits with bounded concurrency, installs the catalog once, then publishes: one five-table
  // reload for the fleet instead of one per account (plan 101, 03.4).
  const recheckAll = async (): Promise<AdminResult<readonly RecheckResult[]>> => {
    const accounts = await deps.accounts.list({})
    const phases = await mapBounded(
      accounts,
      Math.max(1, deps.recheckAllConcurrency ?? 4),
      (account) => commit(account.id, "operator_recovery"),
    )
    if (phases.some((phase) => phase.kind === "committed")) await deps.refreshCatalog()
    const results: RecheckResult[] = []
    for (const phase of phases) {
      const result = phase.kind === "done" ? phase.result : await publish(phase)
      if (result.ok) results.push(result.value)
      else if (result.failure.status !== 404) return result
    }
    return ok(results)
  }

  return { recheck, recheckAll }
}

/** `run` over `items` with at most `limit` in flight; results keep the input order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      const item = items[index] as T
      results[index] = await run(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function recheckView(accountId: string, committed: Committed): RecheckResult {
  const recovery = toRecoveryView(committed.recovery)
  return {
    accountId,
    rechecked: committed.rechecked,
    lastCheckedAt: committed.recovery.requestedAt.toISOString(),
    nextAllowedAt: recovery.nextAllowedAt,
    recovery,
    ...(committed.clearedStatus === null ? {} : { clearedStatus: committed.clearedStatus }),
  }
}

function refusedView(
  accountId: string,
  held: {
    kind: "cooldown" | "busy" | "refused"
    checkInProgress?: boolean
    recovery?: RecoveryPresentationFacts & { requestedAt: Date }
    retryAt: Date
  },
): RecheckResult {
  return {
    accountId,
    rechecked: false,
    checkInProgress: held.kind === "busy" || held.checkInProgress === true,
    lastCheckedAt: held.recovery?.requestedAt.toISOString() ?? null,
    nextAllowedAt: held.retryAt.toISOString(),
    ...(held.recovery === undefined ? {} : { recovery: toRecoveryView(held.recovery) }),
  }
}
