import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

/** Redacted by the tested redactor before write. Never credential material. */
export type AuditDetail = Record<string, unknown>

/**
 * Append-only record of admin-plane mutations: account added, key created,
 * key revoked, policy changed, key value viewed. Viewing a key's value is
 * audited and does not rotate it.
 *
 * `kind` is text, not an enum: the admin surface grows and a new audited action
 * must not require a migration.
 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),

    /** Entity the event concerns — kind + id, with no FK so history outlives the row. */
    subjectType: text("subject_type"),
    /**
     * Text for the same reason `kind` is: not every audited subject is a row. A
     * settings change names the setting it changed, an admin login names the
     * configured operator, and a `uuid` column rejects both at insert time —
     * silently, because those appends are deliberately non-blocking.
     */
    subjectId: text("subject_id"),

    detail: jsonb("detail").$type<AuditDetail>(),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    index("audit_events_kind_created_idx").on(table.kind, table.createdAt),
    index("audit_events_subject_idx").on(table.subjectId),
  ],
)

export type AuditEventRow = typeof auditEvents.$inferSelect
export type NewAuditEventRow = typeof auditEvents.$inferInsert
