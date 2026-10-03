import type { Env } from "../../config/env"
import type { AuditRecorder } from "../admin/audit"
import type { AdminAuthConfig } from "./config"
import type { LocalAdminCredentials } from "./localCredential"
import type { OIDCFlow } from "./oidc/flow"
import type { AdminSession, SessionStore } from "./sessionStore"

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
  startLogin(ip?: string): Promise<LoginStartResult>
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
   * rather than required so no existing caller has to change to keep compiling. `subjectId` is
   * optional for the same reason, and is the session's own username: with several admin emails
   * allowed, that is the only value that says *who* logged out.
   */
  logout(sessionId: string, ip?: string, subjectId?: string): Promise<void>
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
