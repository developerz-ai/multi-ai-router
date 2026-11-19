import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core"

/** Redacted by the tested redactor before write. Never credential material. */
export type AuditDetail = Record<string, unknown>

/**
 * How the caller on an audit row was established. `anonymous` is a sign-in attempt, which by
 * definition arrives holding no accepted credential. `unattributed` is a bug report, never a design:
 * a write that reached the recorder with no caller in context.
 */
export const AUDIT_ACTOR_KINDS = [
  "session",
  "api_token",
  "system",
  "anonymous",
  "unattributed",
] as const
export type AuditActorKind = (typeof AUDIT_ACTOR_KINDS)[number]

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

    /**
     * Who made the change, stamped by the recorder from the request's or the task's audit context
     * (`apps/api/src/services/admin/audit-context.ts`). Nullable: rows written before migration 0049
     * name no caller, and nothing backfills them.
     *
     * `actor` is the session's username (the SSO email), `admin-api-token`, `system`, `anonymous`
     * for a sign-in attempt, or `unknown` when a write reached the recorder with no context. `actor_kind` says which of those it is.
     * `actor_says` is the caller's self-declared name (`X-Admin-Actor`) or a scheduled task's name:
     * self-reported, redacted, never used to authenticate. Text, not enums, for `kind`'s reason.
     */
    actor: text("actor"),
    actorKind: text("actor_kind").$type<AuditActorKind>(),
    actorSays: text("actor_says"),
    clientIp: text("client_ip"),
    userAgent: text("user_agent"),
    requestId: text("request_id"),

    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_events_created_at_idx").on(table.createdAt),
    // The activity feed filtered by kind (`list(limit, kind)`): newest-first within one kind.
    index("audit_events_kind_created_idx").on(table.kind, table.createdAt),
    index("audit_events_subject_idx").on(table.subjectId),
    // "Everything this caller changed", newest first.
    index("audit_events_actor_created_idx").on(table.actor, table.createdAt),
  ],
)

export type AuditEventRow = typeof auditEvents.$inferSelect
export type NewAuditEventRow = typeof auditEvents.$inferInsert
