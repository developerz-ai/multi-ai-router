import { AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"

/**
 * The audit subject for a sign-in that failed before a principal existed. Deliberately not one of
 * the configured admin emails: an OIDC rejection means the router never accepted an identity, and
 * naming a real operator on a row they may have had nothing to do with is a false attribution.
 */
export const UNKNOWN_ADMIN_SUBJECT = "unknown"

/**
 * The one sentence every local-login failure carries, byte-identical to the OIDC
 * callback's. A wrong password, an unconfigured door, and a locked-out address
 * are indistinguishable on the wire on purpose: the answer that names its
 * reason is a probe oracle. The audit log carries the real kind.
 */
export const ADMIN_LOGIN_FAILED_MESSAGE = "Single sign-on verification failed. Try again."

/** The session username a password login runs under — one principal, no user table. */
export const LOCAL_ADMIN_USERNAME = "local-admin"

/**
 * The per-IP lockout tripped. Not a `RouterError`: core's closed code table has
 * no honest code for it, and the route renders the `429` + `Retry-After` itself
 * with the same generic body every other failure gets.
 */
export class AdminLoginThrottledError extends Error {
  readonly retryAfterSeconds: number

  constructor(retryAfterSeconds: number) {
    super("too many failed sign-in attempts")
    this.name = "AdminLoginThrottledError"
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// Audit reporting must never delay or decide an authentication result.
export type AuditFire = (kind: string, detail: Record<string, unknown>, subjectId?: string) => void

export function createAuditFire(recorder: AuditRecorder | undefined): AuditFire {
  return (kind, detail, subjectId) => {
    if (recorder === undefined) return
    const event = {
      kind,
      subjectType: AUDIT_SUBJECTS.admin,
      // The IdP-asserted email is the stable identifier, not the typed username — there is no
      // username anymore. Every OIDC caller passes it explicitly, which is what makes an audit
      // row attributable now that `ADMIN_OIDC_ADMIN_EMAIL` admits several operators: the *configured*
      // value is a list and would name whichever entry happened to sort first, not whoever signed
      // in. A local password login has no email; it records its own constant subject.
      subjectId: subjectId ?? LOCAL_ADMIN_USERNAME,
      detail,
    }
    try {
      void recorder.record(event).catch(() => {
        // Deliberately empty: the append is reporting, and reporting never fails a login.
      })
    } catch {
      // A sink that throws synchronously is the same non-event as one whose promise rejects.
    }
  }
}
