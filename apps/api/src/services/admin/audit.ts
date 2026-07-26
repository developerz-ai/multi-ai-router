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
  /** `account.created`, `key.revoked`, `policy.changed`. */
  readonly kind: string
  readonly subjectType: string
  /**
   * Required, and deliberately not `string | null`. Some subjects have no row — a setting, the
   * admin identity itself — and the temptation is to loosen this for them. Loosening it would
   * drop every one of those events into a single bucket the console's subject filter cannot
   * separate; naming a stable id instead (the setting's name, the configured username) keeps one
   * axis that always answers "what was this about". See `AUDIT_SUBJECTS`.
   */
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
  /**
   * An account that was already connected got a working login back — either the operator re-ran the
   * CLI flow against the existing row, or a probe found the credential healthy and cleared
   * `needs_reauth`. Distinct from `account.connected` so the log separates a first login from a
   * repair, which is the difference between onboarding and an incident.
   */
  accountReauthorized: "account.reauthorized",
  /**
   * An operator pressed "Re-check now" and it took effect. A refused re-check — inside the
   * server-side cooldown — writes nothing, because nothing happened.
   */
  accountRechecked: "account.rechecked",
  /**
   * An operator pressed "Test now" and it ran — a real, opt-in completion against the account's own
   * credential, distinct from a re-check because it actually spends a request (and, on the
   * Agent-SDK path, a subprocess turn). A refused test — inside its cooldown, or declined for lack
   * of confirmation — writes nothing, same as a refused re-check.
   */
  accountTested: "account.tested",
  keyCreated: "key.created",
  keyUpdated: "key.updated",
  keyRevealed: "key.revealed",
  keyRevoked: "key.revoked",
  keyDeleted: "key.deleted",
  poolCreated: "pool.created",
  poolUpdated: "pool.updated",
  poolDeleted: "pool.deleted",
  /**
   * The one pool edit that moves every future request. It is separate from `pool.updated`
   * because "why did traffic move to that account" has to be answerable by filtering a single
   * kind — folded in, the answer is buried among twenty renames and membership tweaks that
   * changed nothing about selection.
   */
  policyChanged: "policy.changed",
  /**
   * A setting the router reads at runtime moved. Distinct from every `*.updated` kind because
   * its subject is a name rather than a row (see `AUDIT_SUBJECTS.settings`), and because a
   * secret-valued setting records that name and nothing else — old → new is only ever written
   * for the settings whose values are safe to keep.
   */
  settingsChanged: "settings.changed",
  /**
   * A credential authenticated on the admin plane. Alone among these kinds it records that
   * nothing changed: it is the row every later mutation is correlated back to when an operator
   * asks who was holding the console at the time.
   */
  adminLogin: "admin.login",
  /**
   * A rejected credential, or an attempt refused while the login is locked out. Separate from
   * `admin.login` so the count stands on its own — a wall of these is what an online guessing
   * attack looks like from the log's side, and mixed in with successes it is invisible.
   */
  adminLoginFailed: "admin.login_failed",
  /**
   * A session ended on purpose. Kept apart from expiry, which writes nothing at all: an operator
   * who logged out and one whose idle window ran out are not the same fact about a session.
   */
  adminLogout: "admin.logout",
} as const

export const AUDIT_SUBJECTS = {
  account: "account",
  key: "api_key",
  pool: "pool",
  /**
   * A setting has no row id, so its subject id is its stable name — `"price_overrides"`. The
   * name is chosen by us and never by a caller, which is what keeps it usable as a filter.
   */
  settings: "settings",
  /**
   * The single admin identity this deployment has. Its subject id is the configured
   * `ADMIN_USERNAME`, never the string someone typed into the login form: a failed login must
   * not be able to write an attacker-chosen subject id into an append-only table.
   */
  admin: "admin",
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
