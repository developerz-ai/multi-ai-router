import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminResult, notFound, ok } from "../admin/result"
import type { AccountAuthProbe, ClaudeAuthReport } from "../health/claudeAuthProbe"

export interface RecheckResult {
  readonly accountId: string
  readonly lastCheckedAt: string
  readonly nextAllowedAt: string
  readonly rechecked: boolean
  readonly clearedStatus?: "exhausted"
  readonly auth?: ClaudeAuthReport
}

export interface RecheckService {
  recheck(accountId: string): Promise<AdminResult<RecheckResult>>
  recheckAll(): Promise<AdminResult<readonly RecheckResult[]>>
  lastCheckedAt(accountId: string): Date | null
}

export interface RecheckServiceDeps {
  readonly accounts: Pick<AccountRepository, "list" | "findById" | "recheckAccount">
  readonly audit: AuditRecorder
  readonly refreshCatalog: () => Promise<void>
  readonly auth?: AccountAuthProbe
  readonly cooldownSeconds: number
  readonly now: () => Date
}

export function createRecheckService(deps: RecheckServiceDeps): RecheckService {
  const lastChecked = new Map<string, Date>()
  const cooldownMs = deps.cooldownSeconds * 1_000

  const refused = (accountId: string, previous: Date): RecheckResult => ({
    accountId,
    lastCheckedAt: previous.toISOString(),
    nextAllowedAt: new Date(previous.getTime() + cooldownMs).toISOString(),
    rechecked: false,
  })

  const attempt = async (account: AccountRow, now: Date): Promise<RecheckResult | undefined> => {
    const previous = lastChecked.get(account.id)
    if (previous !== undefined && now.getTime() - previous.getTime() < cooldownMs) {
      return refused(account.id, previous)
    }

    // Reserve the local button cooldown before awaiting SQL; concurrent callers cannot slip through.
    lastChecked.set(account.id, now)
    let fenced: Awaited<ReturnType<AccountRepository["recheckAccount"]>>
    try {
      fenced = await deps.accounts.recheckAccount({ id: account.id, now })
    } catch (error) {
      if (lastChecked.get(account.id) === now) {
        if (previous === undefined) lastChecked.delete(account.id)
        else lastChecked.set(account.id, previous)
      }
      throw error
    }
    if (fenced === undefined) {
      if (lastChecked.get(account.id) === now) lastChecked.delete(account.id)
      return undefined
    }
    await deps.refreshCatalog()
    const auth = (await deps.auth?.check(fenced.account)) ?? undefined
    const cleared = fenced.clearedStatus

    await deps.audit.record({
      kind: AUDIT_KINDS.accountRechecked,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: account.id,
      detail: {
        provider: account.provider,
        ...(cleared === null ? {} : { clearedStatus: "exhausted" }),
        ...(auth === undefined
          ? {}
          : { loggedIn: auth.loggedIn, statusChangedTo: auth.statusChangedTo }),
      },
    })

    return {
      accountId: account.id,
      lastCheckedAt: now.toISOString(),
      nextAllowedAt: new Date(now.getTime() + cooldownMs).toISOString(),
      rechecked: true,
      ...(cleared === null ? {} : { clearedStatus: "exhausted" as const }),
      ...(auth === undefined ? {} : { auth }),
    }
  }

  return {
    recheck: async (accountId) => {
      const account = await deps.accounts.findById(accountId)
      if (account === undefined) return notFound("No account has that id")
      const result = await attempt(account, deps.now())
      if (result === undefined) return notFound("No account has that id")
      return ok(result)
    },

    lastCheckedAt: (accountId) => lastChecked.get(accountId) ?? null,

    recheckAll: async () => {
      const now = deps.now()
      const accounts = await deps.accounts.list({})
      const results: RecheckResult[] = []
      for (const account of accounts) {
        const result = await attempt(account, now)
        if (result !== undefined) results.push(result)
      }
      return ok(results)
    },
  }
}
