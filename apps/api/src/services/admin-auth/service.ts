import { AdminAuthError, CsrfTokenError } from "@multi-ai-router/core"
import { AUDIT_KINDS, AUDIT_SUBJECTS } from "../admin/audit"
import { type AdminAuthConfig, resolveAdminAuthConfig } from "./config"
import { csrfTokenMatches, mintCsrfToken } from "./csrf"
import type {
  AdminAuthDeps,
  AdminAuthService,
  LoginCompleteResult,
  LoginStartResult,
} from "./service-types"
import { type AdminSession, createMemorySessionStore, sessionExpiryMs } from "./sessionStore"
import {
  deriveSessionSigningKey,
  mintSessionId,
  parseSignedSessionId,
  signSessionId,
} from "./sessionToken"
import { createLoginThrottle, ipThrottleKey } from "./throttle"

export type {
  AdminAuthDeps,
  AdminAuthMethods,
  AdminAuthService,
  LoginCompleteResult,
  LoginStartResult,
} from "./service-types"

const NOT_AUTHENTICATED = "Admin authentication required"
/** What a caller that cannot resolve a peer address records, so the field is always present. */
const UNKNOWN_IP = "unknown"
/**
 * The audit subject for a sign-in that failed before a principal existed. Deliberately not one of
 * the configured admin emails: an OIDC rejection means the router never accepted an identity, and
 * naming a real operator on a row they may have had nothing to do with is a false attribution.
 */
const UNKNOWN_ADMIN_SUBJECT = "unknown"

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

  // Audit reporting must never delay or decide an authentication result.
  function fireAudit(kind: string, detail: Record<string, unknown>, subjectId?: string): void {
    const recorder = deps.audit
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

  const oidcThrottle = createLoginThrottle(config)

  async function startLogin(ip = UNKNOWN_IP): Promise<LoginStartResult> {
    if (deps.oidc == null) {
      // The route turns this into a 404 before the call is ever made; reaching
      // it means a caller skipped that check, and the answer is still not a hint.
      throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE)
    }
    const keys = [ipThrottleKey(ip)]
    const at = now()
    const decision = oidcThrottle.check(keys, at)
    if (!decision.allowed) throw new AdminLoginThrottledError(decision.retryAfterSeconds)
    oidcThrottle.recordFailure(keys, at)
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
    await store.create(session)
    fireAudit(AUDIT_KINDS.adminLogin, { ip: input.ip, ...input.auditDetail }, input.subjectId)
    return {
      session,
      cookieValue: signSessionId(session.id, signingKey),
      cookieMaxAgeSeconds: Math.min(config.idleTtlSeconds, config.absoluteTtlSeconds),
    }
  }

  async function completeLogin(input: {
    code: string
    state: string
    ip: string
  }): Promise<LoginCompleteResult> {
    if (deps.oidc == null) throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE)
    let principal: { readonly email: string; readonly subject: string }
    try {
      principal = await deps.oidc.complete({ code: input.code, state: input.state })
    } catch (err) {
      // Symmetry with `completeLocalLogin`, which has always audited its rejections. Without this
      // the audit feed showed OIDC logins that succeeded and nothing at all for the ones that did
      // not — so a console reporting "sign-in failed" left no row behind to explain it, and the
      // subject is unknowable at this point precisely because the principal check is what failed.
      fireAudit(
        AUDIT_KINDS.adminLoginFailed,
        {
          ip: input.ip,
          method: "oidc",
          // The diagnostic kind, not the wording — the same value the transport logs.
          ...(err instanceof AdminAuthError && err.reason !== undefined
            ? { reason: err.reason }
            : {}),
        },
        UNKNOWN_ADMIN_SUBJECT,
      )
      throw err
    }
    return issueSession({
      // The session's `username` is the IdP-asserted email so the audit log
      // and the console match the human-readable identity the operator
      // logged in with.
      username: principal.email,
      subjectId: principal.email,
      ip: input.ip,
      auditDetail: { subject: principal.subject, email: principal.email, method: "oidc" },
    })
  }

  const localLoginThrottle = createLoginThrottle(config)
  let activePasswordChecks = 0

  async function completeLocalLogin(input: {
    password: string
    ip: string
  }): Promise<LoginCompleteResult> {
    // IP alone: there is no username to count against — the plane is one
    // principal, and a second key would only give a sprayer a second bucket.
    const keys = [ipThrottleKey(input.ip)]
    const nowMs = now()
    const decision = localLoginThrottle.check(keys, nowMs)
    if (!decision.allowed || activePasswordChecks >= config.maxConcurrentLogins) {
      fireAudit(
        AUDIT_KINDS.adminLoginFailed,
        { ip: input.ip, method: "local", reason: "throttled" },
        LOCAL_ADMIN_USERNAME,
      )
      throw new AdminLoginThrottledError(decision.allowed ? 1 : decision.retryAfterSeconds)
    }

    // `deps.local` absent and a wrong password take the exact same path — the
    // wire answer cannot say which one it was, and the argon2 pass inside
    // `verify` cannot either (it runs against a dummy hash when no row exists).
    localLoginThrottle.recordFailure(keys, nowMs)
    activePasswordChecks += 1
    let verified: boolean
    try {
      verified = (await deps.local?.verify(input.password)) ?? false
    } finally {
      activePasswordChecks -= 1
    }
    if (!verified) {
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
    // the store write is coalesced to once per `touchIntervalSeconds` since the last *persisted*
    // `lastSeenAtMs` — the Postgres-backed store sees one write per interval per session, not one
    // per request. The persisted row lags by design: a session never expires early because of
    // this (expiry is checked above, before the slide, against the last-persisted value), it only
    // ever reports a slightly stale `lastSeenAtMs` to anything reading the store directly.
    const slid: AdminSession = {
      ...session,
      lastSeenAtMs: nowMs,
      idleExpiryMs: nowMs + config.idleTtlSeconds * 1000,
    }
    if (nowMs - session.lastSeenAtMs >= config.touchIntervalSeconds * 1000) {
      if (!(await store.touch(slid))) throw new AdminAuthError(NOT_AUTHENTICATED)
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
    logout: async (sessionId, ip, subjectId) => {
      await store.delete(sessionId)
      // After the invalidation, so the row only ever claims a logout that actually happened.
      fireAudit(AUDIT_KINDS.adminLogout, { ip: ip ?? UNKNOWN_IP }, subjectId)
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
