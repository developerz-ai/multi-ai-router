import { and, desc, eq, inArray, max, sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import { type AuditDetail, type AuditEventRow, auditEvents } from "../schema/audit-events"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * The append-only admin-plane audit log. Repositories own SQL; this file is the
 * only place that knows `audit_events` is a table.
 *
 * There is deliberately no `update`, and the one delete cannot name a row: an
 * audit trail that can be edited is not one, and a targeted delete is an edit.
 * Rows leave only through the janitor's retention sweep, only by age.
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
  /**
   * The newest event of any of `kinds` per subject, for every subject in `subjectIds` that has one.
   * `excludeDetailKey` drops events whose `detail` carries that key — how a caller tells an
   * observer's event (`source: "claude_auth_status"`) from an operator's action of the same kind.
   * One query, riding `audit_events_subject_idx`; admin plane and background only.
   */
  latestForSubjects(input: LatestForSubjectsInput): Promise<readonly SubjectEventInstant[]>
  /**
   * Deletes events created before `cutoff` in one bounded batch, oldest first,
   * and returns how many went. Exactly `limit` means there is more to do and the
   * run should report `partial`.
   *
   * Age is the *only* predicate this method accepts. Retaining an audit log for
   * a configured window is policy; letting a caller pick which events disappear
   * is the thing the log exists to prevent.
   */
  deleteOlderThan(cutoff: Date, limit: number): Promise<number>
}

export interface AppendAuditEventInput {
  /** Free text, not an enum: a new audited action must not require a migration. */
  readonly kind: string
  readonly subjectType?: string | null
  readonly subjectId?: string | null
  readonly detail?: AuditDetail | null
}

export interface LatestForSubjectsInput {
  readonly kinds: readonly string[]
  readonly subjectIds: readonly string[]
  readonly excludeDetailKey?: string
}

export interface SubjectEventInstant {
  readonly subjectId: string
  readonly createdAt: Date
}

export function createAuditRepository(db: DatabaseExecutor): AuditRepository {
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

    latestForSubjects: async ({ kinds, subjectIds, excludeDetailKey }) => {
      if (kinds.length === 0 || subjectIds.length === 0) return []
      const rows = await db
        .select({ subjectId: auditEvents.subjectId, createdAt: max(auditEvents.createdAt) })
        .from(auditEvents)
        .where(
          and(
            inArray(auditEvents.subjectId, [...subjectIds]),
            inArray(auditEvents.kind, [...kinds]),
            excludeDetailKey === undefined
              ? undefined
              : sql`coalesce(jsonb_exists(${auditEvents.detail}, ${excludeDetailKey}), false) = false`,
          ),
        )
        .groupBy(auditEvents.subjectId)
      return rows.flatMap((row) =>
        row.subjectId === null || row.createdAt === null
          ? []
          : [{ subjectId: row.subjectId, createdAt: row.createdAt }],
      )
    },

    // Rides `audit_events_created_at_idx`.
    deleteOlderThan: (cutoff, limit) =>
      deleteOldestBatch({
        db,
        table: auditEvents,
        id: auditEvents.id,
        agedBy: auditEvents.createdAt,
        cutoff,
        limit,
      }),
  }
}
