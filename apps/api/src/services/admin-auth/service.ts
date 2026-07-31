import { AdminAuthError, CsrfTokenError } from "@multi-ai-router/core"
import type { Env } from "../../config/env"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../admin/audit"
import { type AdminAuthConfig, resolveAdminAuthConfig } from "./config"
import { csrfTokenMatches, mintCsrfToken } from "./csrf"
import type { LocalAdminCredentials } from "./localCredential"
import type { OIDCFlow } from "./oidc/flow"
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
import { createLoginThrottle, ipThrottleKey } from "./throttle"

/**
 * The admin plane's one authentication service. Everything the routes and the guard do is a
 * call into here; they hold no rules of their own.
 *
 * Session lifetime is **sliding with an absolute cap** — the doc calls for "sliding,
 * idle-expiring" (04-api-keys-and-access.md#session-cookie) because the operator is a human
 * in a console who should not be logged out mid-task, and the cap is there because a purely
 * sliding session is one a thief renews forever. See `config.ts`.
 *
 * Errors are `RouterError`s from `@multi-ai-router/core` so the existing `errorHandler` renders
 * them at their own stable status: `AdminAuthError` (401) for every "this does not authenticate
 * you" outcome, `CsrfTokenError` (403) for a missing or wrong CSRF token. The admin plane never
 * raises `KeyRevokedError` or `ScopeViolationError` — those belong to the data plane's credential
 * space, and the codes on the wire are what tell the two apart.
 *
 * Login outcomes are audited (08-observability.md#audit-events), and the recorder is **optional**
 * on purpose: a router wired without one still authenticates exactly as before, so no boot path
 * and no test has to grow a dependency to keep working. Audit here is reporting, never part of
 * the decision — see `fireAudit`.
 */

export interface AdminAuthDeps {
  /**
   * Straight from `parseEnv`. This service never reads `process.env` and never re-parses it.
   * `adminOidc` is null when the operator signs in with the local password alone — the
   * OIDC half of the plane is simply not built then.
   */
  readonly env: Pick<Env, "adminOidc" | "encryptionKey">
  /** Absent when OIDC is not configured: `startLogin` then throws and the route answers 404. */
  readonly oidc?: OIDCFlow | null
  /**
   * The local password door (`localCredential.ts`). Absent means no deployment ever ran
   * `bin/admin set-password` here — a password guess is answered exactly like a wrong one.
   */
  readonly local?: LocalAdminCredentials | null
  readonly store?: SessionStore
  readonly config?: Partial<AdminAuthConfig>
  /** Injected clock, so expiry and lockout are testable without waiting. */
  readonly now?: () => number
  /** Absent means no audit rows and nothing else different. See the module comment. */
  readonly audit?: AuditRecorder
}

/**
 * The output of `startLogin`. The route mirrors what the browser will see: a URL to redirect
 * to, and the state to send down. The state is opaque to the route and never leaves this
 * service.
 */
export interface LoginStartResult {
  readonly authorizeUrl: string
  readonly state: string
}

/**
 * The output of `completeLogin`. The route mints a session and writes the cookie.
 */
export interface LoginCompleteResult {
  readonly session: AdminSession
  /** The signed value to put in the cookie. */
  readonly cookieValue: string
  readonly cookieMaxAgeSeconds: number
}

export interface AdminAuthService {
  readonly config: AdminAuthConfig
  /** Always resolves. Boots do not wait on OIDC flows. */
  ready(): Promise<void>
  /**
   * Which sign-in methods this deployment offers. `oidc` is configuration;
   * `local` is the presence of the hash row, read live so a `bin/admin`
   * verb takes effect without a restart. Public — the login page asks.
   */
  methods(): Promise<AdminAuthMethods>
  /** Mints a state and an authorize URL. The route redirects the browser. */
  startLogin(): Promise<LoginStartResult>
  /** Trades the callback's `code` for an admin session. */
  completeLogin(input: {
    readonly code: string
    readonly state: string
    readonly ip: string
  }): Promise<LoginCompleteResult>
  /**
   * Trades a password for the same admin session the OIDC callback issues —
   * a second way to OBTAIN the session, not a second session model. Per-IP
   * throttled on the login-throttle seam; every failure, whatever its cause,
   * throws with the one OIDC-identical wording.
   */
  completeLocalLogin(input: {
    readonly password: string
    readonly ip: string
  }): Promise<LoginCompleteResult>
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

/** What `GET /api/admin/auth/methods` renders, and what the login page branches on. */
export interface AdminAuthMethods {
  readonly oidc: boolean
  readonly local: boolean
}

const NOT_AUTHENTICATED = "Admin authentication required"
/** What a caller that cannot resolve a peer address records, so the field is always present. */
const UNKNOWN_IP = "unknown"

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

export function createAdminAuthService(deps: AdminAuthDeps): AdminAuthService {
  const config = resolveAdminAuthConfig(deps.config)
  const store = deps.store ?? createMemorySessionStore()
  const now = deps.now ?? (() => Date.now())
  const signingKey = deriveSessionSigningKey(deps.env.encryptionKey)

  /**
   * Fired, never awaited — the rule `stampLastUsed` follows on the data plane, for the same
   * reason: an append that lost a race or hit a saturated pool says nothing about whether a
   * credential is good, and awaiting it would turn a rejected write into a `500` on a correct
   * credential. It also keeps the two login branches symmetric — success and failure each make
   * exactly one non-blocking call, so the audit adds no measurable time to either and can never
   * become the oracle that tells an attacker which half of the credential was wrong.
   *
   * Both shapes of failure are swallowed: a rejected promise, and a sink that throws before it
   * returns one. Either would otherwise become an unhandled rejection, which is a process-level
   * event, not a login-level one. Nothing is logged because this service is constructed without
   * a logger by design; a dropped audit row is visible as a gap in the table.
   */
  function fireAudit(kind: string, detail: Record<string, unknown>, subjectId?: string): void {
    const recorder = deps.audit
    if (recorder === undefined) return
    const event = {
      kind,
      subjectType: AUDIT_SUBJECTS.admin,
      // The configured admin email is the stable identifier, not the typed
      // username — there is no username anymore. The IdP-asserted email is
      // recorded in the detail on a successful login, by the route. A local
      // password login has no email; it records its own constant subject.
      subjectId: subjectId ?? deps.env.adminOidc?.adminEmail ?? LOCAL_ADMIN_USERNAME,
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

  async function startLogin(): Promise<LoginStartResult> {
    if (deps.oidc == null) {
      // The route turns this into a 404 before the call is ever made; reaching
      // it means a caller skipped that check, and the answer is still not a hint.
      throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE)
    }
    return deps.oidc.start()
  }

  /**
   * The one way a session is minted, shared by both login paths. The OIDC
   * callback and the password form issue byte-identical sessions — the same
   * store, the same cookie signing key, the same sliding window — because a
   * second session model is a second thing to get wrong (issue #52).
   */
  async function issueSession(input: {
    readonly username: string
    readonly subjectId: string
    readonly ip: string
    readonly auditDetail: Record<string, unknown>
  }): Promise<LoginCompleteResult> {
    const session = newSession(input.username, now(), config)
    await store.save(session)
    fireAudit(AUDIT_KINDS.adminLogin, { ip: input.ip, ...input.auditDetail }, input.subjectId)
    return {
      session,
      cookieValue: signSessionId(session.id, signingKey),
      cookieMaxAgeSeconds: config.idleTtlSeconds,
    }
  }

  async function completeLogin(input: {
    code: string
    state: string
    ip: string
  }): Promise<LoginCompleteResult> {
    if (deps.oidc == null) throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE)
    const principal = await deps.oidc.complete({
      code: input.code,
      state: input.state,
    })
    return issueSession({
      // The session's `username` is the IdP-asserted email so the audit log
      // and the console match the human-readable identity the operator
      // logged in with.
      username: principal.email,
      subjectId: deps.env.adminOidc?.adminEmail ?? LOCAL_ADMIN_USERNAME,
      ip: input.ip,
      auditDetail: { subject: principal.subject, email: principal.email, method: "oidc" },
    })
  }

  const localLoginThrottle = createLoginThrottle(config)

  async function completeLocalLogin(input: {
    password: string
    ip: string
  }): Promise<LoginCompleteResult> {
    // IP alone: there is no username to count against — the plane is one
    // principal, and a second key would only give a sprayer a second bucket.
    const keys = [ipThrottleKey(input.ip)]
    const nowMs = now()
    const decision = localLoginThrottle.check(keys, nowMs)
    if (!decision.allowed) {
      fireAudit(
        AUDIT_KINDS.adminLoginFailed,
        { ip: input.ip, method: "local", reason: "throttled" },
        LOCAL_ADMIN_USERNAME,
      )
      throw new AdminLoginThrottledError(decision.retryAfterSeconds)
    }

    // `deps.local` absent and a wrong password take the exact same path — the
    // wire answer cannot say which one it was, and the argon2 pass inside
    // `verify` cannot either (it runs against a dummy hash when no row exists).
    const verified = (await deps.local?.verify(input.password)) ?? false
    if (!verified) {
      localLoginThrottle.recordFailure(keys, nowMs)
      fireAudit(
        AUDIT_KINDS.adminLoginFailed,
        { ip: input.ip, method: "local" },
        LOCAL_ADMIN_USERNAME,
      )
      throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE)
    }

    localLoginThrottle.reset(keys)
    return issueSession({
      username: LOCAL_ADMIN_USERNAME,
      subjectId: LOCAL_ADMIN_USERNAME,
      ip: input.ip,
      auditDetail: { method: "local" },
    })
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

    // The slide. In-memory `lastSeenAtMs` is authoritative for this response on every request;
    // the store write is throttled to once the idle window has advanced past
    // `sessionSlideFraction` of itself since the last *persisted* `lastSeenAtMs` — a
    // Postgres-backed store sees on the order of one write per fraction-of-idle-window, not one
    // per request. The persisted row lags by design: a session never expires early because of
    // this (expiry is checked above, before the slide, against the last-persisted value), it only
    // ever reports a slightly stale `lastSeenAtMs` to anything reading the store directly.
    const slid: AdminSession = {
      ...session,
      lastSeenAtMs: nowMs,
      idleExpiryMs: nowMs + config.idleTtlSeconds * 1000,
    }
    const slideThresholdMs = config.idleTtlSeconds * 1000 * config.sessionSlideFraction
    if (nowMs - session.lastSeenAtMs >= slideThresholdMs) {
      await store.save(slid)
    }
    return slid
  }

  return {
    config,
    ready: () => Promise.resolve(),
    methods: async () => ({
      oidc: deps.oidc != null,
      local: (await deps.local?.isConfigured()) ?? false,
    }),
    startLogin,
    completeLogin,
    completeLocalLogin,
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
