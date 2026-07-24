import { desc, eq } from "drizzle-orm"
import type { Database } from "../client"
import { type AuditDetail, type AuditEventRow, auditEvents } from "../schema/audit-events"

/**
 * The append-only admin-plane audit log. Repositories own SQL; this file is the
 * only place that knows `audit_events` is a table.
 *
 * There is deliberately no `update` and no `delete`: an audit trail that can be
 * edited is not one. Rows leave only through the janitor's retention sweep.
 *
 * **`detail` is redacted before it arrives.** The service layer runs the one
 * tested redactor (`apps/api/src/logging/redact.ts`) over it, so nothing here
 * can carry credential material — see docs/idea/04-api-keys-and-access.md
 * ("Audit events never contain key material").
 */
export interface AuditRepository {
  append(input: AppendAuditEventInput): Promise<AuditEventRow>
  /** Newest first. The admin activity feed. */
  list(limit: number): Promise<AuditEventRow[]>
  listForSubject(subjectId: string, limit: number): Promise<AuditEventRow[]>
}

export interface AppendAuditEventInput {
  /** Free text, not an enum: a new audited action must not require a migration. */
  readonly kind: string
  readonly subjectType?: string | null
  readonly subjectId?: string | null
  readonly detail?: AuditDetail | null
}

export function createAuditRepository(db: Database): AuditRepository {
  return {
    append: async (input) => {
      const rows = await db
        .insert(auditEvents)
        .values({
          kind: input.kind,
          subjectType: input.subjectType ?? null,
          subjectId: input.subjectId ?? null,
          detail: input.detail ?? null,
        })
        .returning()
      const row = rows[0]
      if (row === undefined) {
        throw new Error("auditRepository.append: statement returned no row")
      }
      return row
    },

    list: (limit) =>
      db.select().from(auditEvents).orderBy(desc(auditEvents.createdAt)).limit(limit),

    listForSubject: (subjectId, limit) =>
      db
        .select()
        .from(auditEvents)
        .where(eq(auditEvents.subjectId, subjectId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit),
  }
}
