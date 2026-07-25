import { AdminAuthError, CsrfTokenError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { Env } from "../../config/env"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminAuthConfig, resolveAdminAuthConfig } from "./config"
import { timingSafeEqualStrings } from "./constantTime"
import { csrfTokenMatches, mintCsrfToken } from "./csrf"
import { createPasswordVerifier, type PasswordVerifier } from "./password"
import {
  type AdminSession,
  createMemorySessionStore,
  type SessionStore,
  sessionExpiryMs,
} from "./sessionStore"
import {
  deriveSessionSigningKey,
  mintSessionId,
  parseSignedSessionId,
  signSessionId,
} from "./sessionToken"
import {
  createLoginThrottle,
  ipThrottleKey,
  type LoginThrottle,
  usernameThrottleKey,
} from "./throttle"

/**
 * The admin plane's one authentication service. Everything the routes and the guard do is a
 * call into here; they hold no rules of their own.
 *
 * Session lifetime is **sliding with an absolute cap** — the doc calls for "sliding,
 * idle-expiring" (04-api-keys-and-access.md#session-cookie) because the operator is a human in
 * a console who should not be logged out mid-task, and the cap is there because a purely
 * sliding session is one a thief renews forever. See `config.ts`.
 *
 * Errors are `RouterError`s from `@multi-ai-router/core` so the existing `errorHandler` renders
 * them at their own stable status: `AdminAuthError` (401) for every "this does not authenticate
 * you" outcome, `CsrfTokenError` (403) for a missing or wrong CSRF token, `QuotaExhaustedError`
 * (429 + `Retry-After`) while a login key is locked out. The admin plane never raises
 * `KeyRevokedError` or `ScopeViolationError` — those belong to the data plane's credential
 * space, and the codes on the wire are what tell the two apart.
 *
 * Login outcomes are audited (08-observability.md#audit-events), and the recorder is **optional**
 * on purpose: a router wired without one still authenticates exactly as before, so no boot path
 * and no test has to grow a dependency to keep working. Audit here is reporting, never part of
 * the decision — see `fireAudit`.
 */

export interface AdminAuthDeps {
  /** Straight from `parseEnv`. This service never reads `process.env` and never re-parses it. */
  readonly env: Pick<Env, "adminUsername" | "adminCredential" | "encryptionKey">
  readonly store?: SessionStore
  readonly config?: Partial<AdminAuthConfig>
  /** Injected clock, so expiry and lockout are testable without waiting. */
  readonly now?: () => number
  /** Absent means no audit rows and nothing else different. See the module comment. */
  readonly audit?: AuditRecorder
}

export interface LoginInput {
  readonly username: string
  readonly password: string
  /** Client address, already resolved by transport against `TRUST_PROXY`. */
  readonly ip: string
}

export interface LoginResult {
  readonly session: AdminSession
  /** The signed value to put in the cookie. */
  readonly cookieValue: string
  readonly cookieMaxAgeSeconds: number
}

export interface AdminAuthService {
  readonly config: AdminAuthConfig
  /** Forces the boot-time argon2id hash to exist. Boot awaits it; login never pays for it. */
  ready(): Promise<void>
  login(input: LoginInput): Promise<LoginResult>
  /**
   * Ends the session server-side. `ip` is optional because the audit row wants the source
   * address (08-observability.md) and the caller is the only one who can resolve it — optional
   * rather than required so no existing caller has to change to keep compiling.
   */
  logout(sessionId: string, ip?: string): Promise<void>
  /** Resolves the session a cookie names, sliding its idle window. Throws when it does not. */
  authenticate(cookieValue: string | undefined): Promise<AdminSession>
  /** Throws unless the presented token matches the session's own. */
  assertCsrf(session: AdminSession, presented: string | undefined): void
}

const INVALID_CREDENTIALS = "Invalid username or password"
const NOT_AUTHENTICATED = "Admin authentication required"
/** What a caller that cannot resolve a peer address records, so the field is always present. */
const UNKNOWN_IP = "unknown"

export function createAdminAuthService(deps: AdminAuthDeps): AdminAuthService {
  const config = resolveAdminAuthConfig(deps.config)
  const store = deps.store ?? createMemorySessionStore()
  const now = deps.now ?? (() => Date.now())
  const signingKey = deriveSessionSigningKey(deps.env.encryptionKey)
  const verifier: PasswordVerifier = createPasswordVerifier(deps.env.adminCredential)
  const throttle: LoginThrottle = createLoginThrottle(config)

  /**
   * Fired, never awaited — the rule `stampLastUsed` follows on the data plane, for the same
   * reason: an append that lost a race or hit a saturated pool says nothing about whether a
   * credential is good, and awaiting it would turn a rejected write into a `500` on a correct
   * password. It also keeps the two login branches symmetric — success and failure each make
   * exactly one non-blocking call, so the audit adds no measurable time to either and can never
   * become the oracle that tells an attacker which half of the credential was wrong.
   *
   * Both shapes of failure are swallowed: a rejected promise, and a sink that throws before it
   * returns one. Either would otherwise become an unhandled rejection, which is a process-level
   * event, not a login-level one. Nothing is logged because this service is constructed without
   * a logger by design; a dropped audit row is visible as a gap in the table.
   */
  function fireAudit(kind: string, detail: Record<string, unknown>): void {
    const recorder = deps.audit
    if (recorder === undefined) return
    const event = {
      kind,
      subjectType: AUDIT_SUBJECTS.admin,
      // The configured admin, never the string that was typed — see `AUDIT_SUBJECTS.admin`.
      subjectId: deps.env.adminUsername,
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

  async function login(input: LoginInput): Promise<LoginResult> {
    const keys = [usernameThrottleKey(input.username), ipThrottleKey(input.ip)]
    const nowMs = now()

    const decision = throttle.check(keys, nowMs)
    if (!decision.allowed) {
      // Still a failed login, flagged so the operator can tell the two apart at a glance: a
      // handful of unflagged rows is someone mistyping, a wall of `locked: true` is someone
      // hammering a locked account and worth reacting to.
      fireAudit(AUDIT_KINDS.adminLoginFailed, {
        ip: input.ip,
        locked: true,
        usernameMatched: timingSafeEqualStrings(input.username, deps.env.adminUsername),
      })
      throw new QuotaExhaustedError("Too many login attempts. Try again later.", {
        retryAfterSeconds: decision.retryAfterSeconds,
      })
    }

    // Both factors are evaluated every time, in the same order, at the same cost. The password
    // hash is verified even when the username is wrong, so an unknown username and a wrong
    // password are indistinguishable in both the response and the time it takes to produce it.
    const usernameOk = timingSafeEqualStrings(input.username, deps.env.adminUsername)
    const passwordOk = await verifier.verify(input.password)

    if (!usernameOk || !passwordOk) {
      throttle.recordFailure(keys, nowMs)
      // The detail is the source address and two flags, and nothing else on purpose. The typed
      // username is not recorded even though the spec allows it: an operator who fat-fingers the
      // password into the username box would have it written to an append-only table, and a
      // probe would get its guesses stored verbatim. `usernameMatched` carries the only part
      // worth keeping — true means the attempt named the configured admin, which is already this
      // row's subject id, so nothing is lost and no caller-chosen string is kept.
      fireAudit(AUDIT_KINDS.adminLoginFailed, {
        ip: input.ip,
        locked: false,
        usernameMatched: usernameOk,
      })
      throw new AdminAuthError(INVALID_CREDENTIALS)
    }

    throttle.reset(keys)
    const session = newSession(deps.env.adminUsername, nowMs, config)
    await store.save(session)
    // The session id and the CSRF token are credentials for the life of this session, so neither
    // goes in the detail; the source address is the whole of what the spec asks for.
    fireAudit(AUDIT_KINDS.adminLogin, { ip: input.ip })

    return {
      session,
      cookieValue: signSessionId(session.id, signingKey),
      cookieMaxAgeSeconds: config.idleTtlSeconds,
    }
  }

  async function authenticate(cookieValue: string | undefined): Promise<AdminSession> {
    if (cookieValue === undefined || cookieValue.length === 0) {
      throw new AdminAuthError(NOT_AUTHENTICATED)
    }

    const id = parseSignedSessionId(cookieValue, signingKey)
    if (id === null) throw new AdminAuthError(NOT_AUTHENTICATED)

    const session = await store.get(id)
    if (session === undefined) throw new AdminAuthError(NOT_AUTHENTICATED)

    const nowMs = now()
    if (sessionExpiryMs(session) <= nowMs) {
      // Expiry is an invalidation, not a filter: the record goes away with the answer.
      await store.delete(session.id)
      throw new AdminAuthError("Admin session has expired")
    }

    // The slide. TODO(M7): a Postgres-backed store should not write on every request — persist
    // only once the idle window has advanced past a fraction of itself.
    const slid: AdminSession = {
      ...session,
      lastSeenAtMs: nowMs,
      idleExpiryMs: nowMs + config.idleTtlSeconds * 1000,
    }
    await store.save(slid)
    return slid
  }

  return {
    config,
    ready: () => verifier.ready(),
    login,
    logout: async (sessionId, ip) => {
      await store.delete(sessionId)
      // After the invalidation, so the row only ever claims a logout that actually happened.
      fireAudit(AUDIT_KINDS.adminLogout, { ip: ip ?? UNKNOWN_IP })
    },
    authenticate,
    assertCsrf(session, presented) {
      if (!csrfTokenMatches(session, presented)) {
        throw new CsrfTokenError("Missing or invalid CSRF token")
      }
    },
  }
}

function newSession(username: string, nowMs: number, config: AdminAuthConfig): AdminSession {
  return {
    id: mintSessionId(),
    username,
    csrfToken: mintCsrfToken(),
    createdAtMs: nowMs,
    lastSeenAtMs: nowMs,
    idleExpiryMs: nowMs + config.idleTtlSeconds * 1000,
    absoluteExpiryMs: nowMs + config.absoluteTtlSeconds * 1000,
  }
}
