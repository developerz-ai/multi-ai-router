import { AdminAuthError, CsrfTokenError } from "@multi-ai-router/core"
import { AUDIT_KINDS } from "../admin/audit"
import { UNKNOWN_CLIENT_IP } from "./clientIp"
import { type AdminAuthConfig, resolveAdminAuthConfig } from "./config"
import { csrfTokenMatches, mintCsrfToken } from "./csrf"
import {
  ADMIN_LOGIN_FAILED_MESSAGE,
  AdminLoginThrottledError,
  createAuditFire,
  LOCAL_ADMIN_USERNAME,
  UNKNOWN_ADMIN_SUBJECT,
} from "./login-outcomes"
import { createCachedLocalConfigured, sessionPrincipalAdmitted } from "./principal"
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
export { ADMIN_LOGIN_FAILED_MESSAGE, AdminLoginThrottledError, LOCAL_ADMIN_USERNAME }

const NOT_AUTHENTICATED = "Admin authentication required"
const UNKNOWN_IP = UNKNOWN_CLIENT_IP
/** `ADMIN_CREDENTIAL_METADATA_TTL_SECONDS`' default — how stale "is a password set" may be. */
const DEFAULT_LOCAL_CREDENTIAL_TTL_MS = 60_000
export function createAdminAuthService(deps: AdminAuthDeps): AdminAuthService {
  const config = resolveAdminAuthConfig(deps.config)
  const store = deps.store ?? createMemorySessionStore()
  const now = deps.now ?? (() => Date.now())
  const signingKey = deriveSessionSigningKey(deps.env.encryptionKey)
  const localConfigured = createCachedLocalConfigured(
    deps.local,
    deps.localCredentialTtlMs ?? DEFAULT_LOCAL_CREDENTIAL_TTL_MS,
    now,
  )
  const throttleOptions = { evictionIntervalMs: deps.throttleEvictionIntervalMs }

  const fireAudit = createAuditFire(deps.audit)

  const oidcThrottle = createLoginThrottle(config, throttleOptions)
  // Its own buckets: one sign-in is a start and a callback, and charging both to one bucket would
  // halve the attempts an operator gets.
  const callbackThrottle = createLoginThrottle(config, throttleOptions)

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
    // Before the state is consumed: an unthrottled callback was one `oauth_states` query and one
    // audit row per unauthenticated hit.
    const keys = [ipThrottleKey(input.ip)]
    const at = now()
    const decision = callbackThrottle.check(keys, at)
    if (!decision.allowed) {
      if (decision.firstDenial) {
        fireAudit(
          AUDIT_KINDS.adminLoginFailed,
          { ip: input.ip, method: "oidc", reason: "throttled" },
          UNKNOWN_ADMIN_SUBJECT,
        )
      }
      throw new AdminLoginThrottledError(decision.retryAfterSeconds)
    }
    let principal: { readonly email: string; readonly subject: string }
    try {
      principal = await deps.oidc.complete({ code: input.code, state: input.state })
    } catch (err) {
      callbackThrottle.recordFailure(keys, at)
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
    // A completed sign-in is not an attack: the starts and callbacks it took stop counting.
    oidcThrottle.reset(keys)
    callbackThrottle.reset(keys)
    return issueSession({
      // The session's `username` is the IdP-asserted email, lowercased like the allowlist it was
      // admitted by, so `authenticate` re-checks it against that list and `bin/admin
      // revoke-sessions --user` finds it whatever case the IdP asserted.
      username: principal.email.toLowerCase(),
      subjectId: principal.email,
      ip: input.ip,
      auditDetail: { subject: principal.subject, email: principal.email, method: "oidc" },
    })
  }

  const localLoginThrottle = createLoginThrottle(config, throttleOptions)
  let activePasswordChecks = 0
  // One audit row per saturation episode, not per refused request; an episode ends when the
  // last running check does.
  let saturationReported = false

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
      // The lockout transition is audited, not every refusal after it: a refused request is
      // unauthenticated, and a row per refusal is a write an attacker can repeat forever.
      const firstDenial = decision.allowed ? !saturationReported : decision.firstDenial
      if (decision.allowed) saturationReported = true
      if (firstDenial) {
        fireAudit(
          AUDIT_KINDS.adminLoginFailed,
          { ip: input.ip, method: "local", reason: "throttled" },
          LOCAL_ADMIN_USERNAME,
        )
      }
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
      if (activePasswordChecks === 0) saturationReported = false
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
    localConfigured.remember(true)
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
    const admitted = sessionPrincipalAdmitted(session.username, {
      localUsername: LOCAL_ADMIN_USERNAME,
      localConfigured: session.username === LOCAL_ADMIN_USERNAME && (await localConfigured.get()),
      oidc: deps.env.adminOidc,
    })
    if (!admitted) {
      // The password was removed or the email left the allowlist: the session goes with it.
      await store.delete(session.id)
      throw new AdminAuthError(NOT_AUTHENTICATED)
    }

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
      local: await localConfigured.get(),
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
