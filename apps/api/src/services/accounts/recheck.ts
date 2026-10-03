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
  readonly lastCheckedAt: string
  readonly nextAllowedAt: string
  /** A new durable request was accepted; this does not report provider health. */
  readonly rechecked: boolean
  readonly recovery: AccountRecoveryView
  readonly clearedStatus?: "exhausted"
  readonly auth?: ClaudeAuthReport
}
export interface RecheckService {
  recheck(accountId: string): Promise<AdminResult<RecheckResult>>
  recheckAll(): Promise<AdminResult<readonly RecheckResult[]>>
}
/** Runtime's atomic repository supplies database time and durable cooldown. */
export interface OperatorRecoveryRepository {
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
  readonly cooldownSeconds: number
}

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  const attempt = async (accountId: string): Promise<AdminResult<RecheckResult>> => {
    const held = await deps.recovery.readOperatorCooldown(accountId)
    if (held !== undefined) return ok(recheckView(accountId, held))
    const original = await deps.accounts.findById(accountId)
    if (original === undefined) return notFound("No account has that id")
    // No database lock crosses the CLI call. Its guarded positive mutation finishes first.
    const auth = (await deps.auth?.check(original)) ?? undefined
    const committed = await deps.recovery.beginOperatorRecovery({
      accountId,
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
    if (committed === undefined) return notFound("No account has that id")
    if (committed.rechecked) {
      // A committed pending restriction must reach local routing even if audit later fails.
      await deps.refreshCatalog()
      if (committed.recovery.state === "pending") deps.onRecoveryRequested?.(accountId)
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
  }
  return {
    recheck: attempt,
    recheckAll: async () => {
      const accounts = await deps.accounts.list({})
      const results: RecheckResult[] = []
      for (const account of accounts) {
        const result = await attempt(account.id)
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
