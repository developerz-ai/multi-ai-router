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
export interface RecheckService {
  recheck(accountId: string): Promise<AdminResult<RecheckResult>>
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
  readonly operatorCheckLeaseMs?: number
  readonly cooldownSeconds: number
}

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  const attempt = async (accountId: string): Promise<AdminResult<RecheckResult>> => {
    const claimToken = crypto.randomUUID()
    const claim = await deps.recovery.reserveOperatorCheck({
      accountId,
      claimToken,
      leaseMs: deps.operatorCheckLeaseMs ?? 30_000,
    })
    if (claim === undefined) return notFound("No account has that id")
    if (claim.kind !== "acquired") return ok(refusedView(accountId, claim))
    const original = claim.account
    try {
      // No database lock crosses the CLI call; its token fences post-lease authentication mutations.
      const auth = (await deps.auth?.check(original, claimToken)) ?? undefined
      const finalized = await deps.recovery.finalizeOperatorCheck({
        accountId,
        claimToken,
        generationCandidate: crypto.randomUUID(),
        cooldownMs: deps.cooldownSeconds * 1_000,
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
      if (finalized === undefined) return notFound("No account has that id")
      if (finalized.kind === "refused") return ok(refusedView(accountId, finalized))
      const committed = finalized.result
      if (committed === undefined) return notFound("No account has that id")
      // Our reserved authentication check can publish a recovery even when finalization joins its cooldown.
      await deps.refreshCatalog()
      if (committed.recovery.state === "pending") deps.onRecoveryRequested?.(accountId)
      if (committed.rechecked) {
        // A committed pending restriction must reach local routing even if audit later fails.
        await deps.audit.record({
          kind: AUDIT_KINDS.accountRechecked,
          subjectType: AUDIT_SUBJECTS.account,
          subjectId: accountId,
          detail: {
            provider: committed.account.provider,
            source: "operator_recovery",
            ...(committed.clearedStatus === null ? {} : { clearedStatus: committed.clearedStatus }),
            ...(auth === undefined
              ? {}
              : { loggedIn: auth.loggedIn, statusChangedTo: auth.statusChangedTo }),
          },
        })
      }
      return ok({ ...recheckView(accountId, committed), ...(auth === undefined ? {} : { auth }) })
    } finally {
      await deps.recovery.releaseOperatorCheck({ accountId, claimToken })
    }
  }
  const flights = new Map<string, Promise<AdminResult<RecheckResult>>>()
  const recheck = (accountId: string): Promise<AdminResult<RecheckResult>> => {
    const held = flights.get(accountId)
    if (held !== undefined) return held
    const flight = attempt(accountId).finally(() => {
      if (flights.get(accountId) === flight) flights.delete(accountId)
    })
    flights.set(accountId, flight)
    return flight
  }
  return {
    recheck,
    recheckAll: async () => {
      const accounts = await deps.accounts.list({})
      const results: RecheckResult[] = []
      for (const account of accounts) {
        const result = await recheck(account.id)
        if (result.ok) results.push(result.value)
        else if (result.failure.status !== 404) return result
      }
      return ok(results)
    },
  }
}

function recheckView(
  accountId: string,
  committed: NonNullable<Awaited<ReturnType<OperatorRecoveryRepository["beginOperatorRecovery"]>>>,
): RecheckResult {
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
