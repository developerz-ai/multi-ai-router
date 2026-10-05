import type { AuditRepository } from "@multi-ai-router/db"
import { AUDIT_KINDS } from "../admin/audit"

/**
 * When each subscription was last logged in **interactively** — the instant an estimated login
 * lifetime counts from (`login-lifetime.ts`).
 *
 * Read off the audit log, which already records every completed CLI login as `account.connected`
 * (first) or `account.reauthorized` (again). The auth probe also writes `account.reauthorized` when
 * a parked account turns out logged in after all; that is an observation, not a login, and it
 * carries `source: "claude_auth_status"` — so events with a `source` are excluded. One query for
 * any number of accounts; admin plane and scheduler only, never the request path.
 *
 * An account whose login predates `RETENTION_AUDIT_DAYS` simply has no entry, and its lifetime
 * reads `unknown` rather than a wrong estimate.
 */
export type LastLoginLookup = (accountIds: readonly string[]) => Promise<ReadonlyMap<string, Date>>

export function createLastLoginLookup(
  audit: Pick<AuditRepository, "latestForSubjects">,
): LastLoginLookup {
  return async (accountIds) => {
    if (accountIds.length === 0) return new Map()
    const rows = await audit.latestForSubjects({
      kinds: [AUDIT_KINDS.accountConnected, AUDIT_KINDS.accountReauthorized],
      subjectIds: accountIds,
      excludeDetailKey: "source",
    })
    return new Map(rows.map((row) => [row.subjectId, row.createdAt]))
  }
}
