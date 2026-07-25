import { redact } from "../../logging/redact"

/**
 * Every admin-plane mutation writes one `AuditEvent`. Append-only, and it never
 * carries credential material — docs/idea/04-api-keys-and-access.md ("Every
 * mint, edit, and revocation writes an `AuditEvent`. Audit events never contain
 * key material. A key reveal is itself an audited read.")
 *
 * The guarantee is enforced here rather than trusted at each call site: every
 * detail object goes through the one tested redactor before it reaches the
 * repository, so a field a future caller adds carelessly is scrubbed by name
 * (`*token*`, `*secret*`, `*credential*`, `*password*`) and by value (a
 * `mar_live_…` string, a `sk-…` string, a `Bearer …` string) rather than
 * written. There is deliberately no way to bypass it.
 */

/** The subset of `AuditRepository` this recorder needs. Structural, so a test needs no database. */
export interface AuditSink {
  append(input: {
    readonly kind: string
    readonly subjectType?: string | null
    readonly subjectId?: string | null
    readonly detail?: Record<string, unknown> | null
  }): Promise<unknown>
}

export interface AuditEventInput {
  /** `account.created`, `key.revoked`, `pool.policy_changed`. */
  readonly kind: string
  readonly subjectType: string
  readonly subjectId: string
  /** What changed, in operator terms. Never a value — always a name, a count, or a flag. */
  readonly detail?: Record<string, unknown>
}

export interface AuditRecorder {
  record(event: AuditEventInput): Promise<void>
}

/** The kinds the admin API writes. One place, so the console can filter on a known set. */
export const AUDIT_KINDS = {
  accountCreated: "account.created",
  accountUpdated: "account.updated",
  accountDisabled: "account.disabled",
  accountDeleted: "account.deleted",
  /** A subscription login completed against this account's own config directory. */
  accountConnected: "account.connected",
  keyCreated: "key.created",
  keyUpdated: "key.updated",
  keyRevealed: "key.revealed",
  keyRevoked: "key.revoked",
  keyDeleted: "key.deleted",
  poolCreated: "pool.created",
  poolUpdated: "pool.updated",
  poolDeleted: "pool.deleted",
} as const

export const AUDIT_SUBJECTS = {
  account: "account",
  key: "api_key",
  pool: "pool",
} as const

export function createAuditRecorder(sink: AuditSink): AuditRecorder {
  return {
    record: async (event) => {
      await sink.append({
        kind: event.kind,
        subjectType: event.subjectType,
        subjectId: event.subjectId,
        detail: event.detail === undefined ? null : redact(event.detail),
      })
    },
  }
}
