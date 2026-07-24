import { AdminAuthError, CsrfTokenError, QuotaExhaustedError } from "@multi-ai-router/core"
import type { Env } from "../../config/env"
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
 */

export interface AdminAuthDeps {
  /** Straight from `parseEnv`. This service never reads `process.env` and never re-parses it. */
  readonly env: Pick<Env, "adminUsername" | "adminCredential" | "encryptionKey">
  readonly store?: SessionStore
  readonly config?: Partial<AdminAuthConfig>
  /** Injected clock, so expiry and lockout are testable without waiting. */
  readonly now?: () => number
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
  logout(sessionId: string): Promise<void>
  /** Resolves the session a cookie names, sliding its idle window. Throws when it does not. */
  authenticate(cookieValue: string | undefined): Promise<AdminSession>
  /** Throws unless the presented token matches the session's own. */
  assertCsrf(session: AdminSession, presented: string | undefined): void
}

const INVALID_CREDENTIALS = "Invalid username or password"
const NOT_AUTHENTICATED = "Admin authentication required"

export function createAdminAuthService(deps: AdminAuthDeps): AdminAuthService {
  const config = resolveAdminAuthConfig(deps.config)
  const store = deps.store ?? createMemorySessionStore()
  const now = deps.now ?? (() => Date.now())
  const signingKey = deriveSessionSigningKey(deps.env.encryptionKey)
  const verifier: PasswordVerifier = createPasswordVerifier(deps.env.adminCredential)
  const throttle: LoginThrottle = createLoginThrottle(config)

  async function login(input: LoginInput): Promise<LoginResult> {
    const keys = [usernameThrottleKey(input.username), ipThrottleKey(input.ip)]
    const nowMs = now()

    const decision = throttle.check(keys, nowMs)
    if (!decision.allowed) {
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
      // TODO(M7): write a failed-login AuditEvent once the audit repository exists
      // (07-security.md#admin-plane). It must record the username *attempted*, never the
      // password, and never distinguish the two failure causes to the caller.
      throttle.recordFailure(keys, nowMs)
      throw new AdminAuthError(INVALID_CREDENTIALS)
    }

    throttle.reset(keys)
    const session = newSession(deps.env.adminUsername, nowMs, config)
    await store.save(session)

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
    logout: (sessionId) => store.delete(sessionId),
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
