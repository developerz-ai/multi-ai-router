import { createHash } from "node:crypto"
import { AdminAuthError } from "@multi-ai-router/core"
import { type DiscoveryDocument, discoverySchema, OIDCDiscoveryError } from "./discovery"
import { assertEmailVerified, OIDCIdTokenInvalidError, verifyIdToken } from "./idToken"
import { createJWKSCache, OIDCJWKSError } from "./jwks"
import { createOIDCStateStore, OIDCStateMismatchError, type OIDCStateStoreDeps } from "./state"

/**
 * The two halves of the admin-OIDC flow.
 *
 *  - `start()` mints a state + nonce + PKCE verifier, builds the authorization
 *    URL with PKCE S256, and returns the URL to redirect the browser to.
 *  - `complete()` consumes the state, exchanges the code for tokens, verifies
 *    the id_token, asserts the principal matches the configured admin, and
 *    returns the email + sub to the caller.
 *
 * One wording for every rejection. Anything that says *why* the call failed is
 * a probe oracle: the operator's next move is the same in every case.
 *
 * The flow is built once at composition time and reused; the rest of the
 * admin plane never touches the IdP directly.
 */

const PKCE_METHOD = "S256"

export interface OIDCFlowConfig {
  /** The exact issuer URL. The discovery doc must match it. */
  readonly issuerUrl: string
  /** Client id; also the expected `aud`. */
  readonly clientId: string
  /** Client secret. Null for a public client; the public client still uses PKCE. */
  readonly clientSecret: string | null
  /** Where the IdP sends the browser back. Must be one of the registered redirect URIs. */
  readonly redirectUri: string
  /** The principal that may sign in. The IdP-asserted email must match this. */
  readonly adminEmail: string
  /** Optional stricter check: the `sub` claim must match this exactly. */
  readonly adminSubject?: string | null
  /** Scopes to request. `openid` is mandatory; the rest are passed through. */
  readonly scopes: readonly string[]
  /** Maximum number of accepted clock-skew seconds. */
  readonly clockSkewSeconds?: number
}

export class OIDCPrincipalMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OIDCPrincipalMismatchError"
  }
}

/** Collapses every failure to a single wording for the operator-facing answer. */
const OIDC_VERIFICATION_FAILED = "Single sign-on verification failed. Try again."

export interface OIDCFlow {
  /** Builds the authorize URL and the state row for it. The state is the IdP-opaque value. */
  start(): Promise<{ readonly authorizeUrl: string; readonly state: string }>
  /**
   * Trades the callback's `code` for an id_token, verifies it, and returns the
   * principal the admin plane should pin the session to.
   *
   * Throws {@link AdminAuthError} on every failure. The message is the single
   * wording; the *kind* is what the audit log records.
   */
  complete(input: {
    readonly code: string
    readonly state: string
  }): Promise<{ readonly email: string; readonly subject: string }>
}

export interface OIDCFlowDeps {
  readonly config: OIDCFlowConfig
  readonly stateStore: OIDCStateStoreDeps
  /** The current `fetch` for token-exchange requests. Injected so tests can stub the IdP. */
  readonly fetch?: typeof fetch
  /** Clock, for tests. */
  readonly now?: () => Date
}

export function createOIDCFlow(deps: OIDCFlowDeps): OIDCFlow {
  const { config } = deps
  const now = deps.now ?? ((): Date => new Date())
  const execFetch: typeof fetch = deps.fetch ?? fetch
  const discoveryFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)
    try {
      return await execFetch(url, init)
    } finally {
      clearTimeout(timer)
    }
  }
  const stateStore = createOIDCStateStore(deps.stateStore)

  let cachedJwks: ReturnType<typeof createJWKSCache> | null = null
  let cachedDiscovery: DiscoveryDocument | null = null

  async function discover(): Promise<DiscoveryDocument> {
    if (cachedDiscovery !== null) return cachedDiscovery
    const res = await discoveryFetch(
      `${config.issuerUrl.replace(/\/+$/u, "")}/.well-known/openid-configuration`,
    )
    if (!res.ok) {
      throw new OIDCDiscoveryError(`discovery endpoint returned ${res.status}`, "fetch_failed")
    }
    let body: unknown
    try {
      body = await res.json()
    } catch {
      throw new OIDCDiscoveryError("discovery endpoint did not return JSON", "parse_failed")
    }
    const parsed = discoverySchema.safeParse(body)
    if (!parsed.success) {
      throw new OIDCDiscoveryError(
        "discovery document is missing required fields",
        "validation_failed",
      )
    }
    if (parsed.data.issuer.replace(/\/+$/u, "") !== config.issuerUrl.replace(/\/+$/u, "")) {
      throw new OIDCDiscoveryError(
        `discovery document issuer "${parsed.data.issuer}" does not match configured issuer`,
        "validation_failed",
      )
    }
    if (
      !parsed.data.code_challenge_methods_supported?.includes("S256") &&
      !parsed.data.code_challenge_methods_supported?.includes("s256")
    ) {
      throw new OIDCDiscoveryError(
        "discovery document does not advertise PKCE S256 support",
        "unsupported",
      )
    }
    cachedDiscovery = parsed.data
    cachedJwks = createJWKSCache(cachedDiscovery.jwks_uri, { fetch: discoveryFetch }, () =>
      now().getTime(),
    )
    return cachedDiscovery
  }

  async function exchangeCode(
    tokenEndpoint: string,
    code: string,
    codeVerifier: string,
  ): Promise<{ id_token: string }> {
    const params = new URLSearchParams()
    params.set("grant_type", "authorization_code")
    params.set("code", code)
    params.set("redirect_uri", config.redirectUri)
    params.set("client_id", config.clientId)
    if (config.clientSecret !== null) params.set("client_secret", config.clientSecret)
    params.set("code_verifier", codeVerifier)
    const exec = deps.fetch ?? fetch
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15_000)
    try {
      const res = await exec(tokenEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: params.toString(),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new AdminAuthError(OIDC_VERIFICATION_FAILED)
      }
      const body = (await res.json()) as { id_token?: unknown }
      if (typeof body.id_token !== "string" || body.id_token.length === 0) {
        throw new AdminAuthError(OIDC_VERIFICATION_FAILED)
      }
      return { id_token: body.id_token }
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    async start() {
      const doc = await discover()
      const issued = await stateStore.issue()
      const challenge = createHash("sha256").update(issued.codeVerifier).digest("base64url")
      const url = new URL(doc.authorization_endpoint)
      url.searchParams.set("response_type", "code")
      url.searchParams.set("client_id", config.clientId)
      url.searchParams.set("redirect_uri", config.redirectUri)
      url.searchParams.set("scope", [...config.scopes].join(" "))
      url.searchParams.set("state", issued.state)
      url.searchParams.set("nonce", issued.nonce)
      url.searchParams.set("code_challenge", challenge)
      url.searchParams.set("code_challenge_method", PKCE_METHOD)
      return { authorizeUrl: url.toString(), state: issued.state }
    },

    async complete({ code, state }) {
      let principal: { email: string; subject: string } | null = null
      try {
        const doc = await discover()
        const consumed = await stateStore.consume(state)
        const tokenResponse = await exchangeCode(doc.token_endpoint, code, consumed.codeVerifier)
        const verified = await verifyIdToken(
          {
            token: tokenResponse.id_token,
            issuer: config.issuerUrl.replace(/\/+$/u, ""),
            audience: config.clientId,
            nonce: consumed.nonce,
            clockSkewSeconds: config.clockSkewSeconds ?? 60,
            nowSeconds: () => Math.floor(now().getTime() / 1000),
          },
          { jwks: cachedJwks ?? createJWKSCache(doc.jwks_uri, undefined, () => now().getTime()) },
        )
        const { email, sub } = assertEmailVerified(verified.claims)
        if (email.toLowerCase() !== config.adminEmail.toLowerCase()) {
          throw new OIDCPrincipalMismatchError(
            `sign-in email "${email}" does not match the configured admin`,
          )
        }
        if (config.adminSubject !== undefined && config.adminSubject !== null) {
          if (sub !== config.adminSubject) {
            throw new OIDCPrincipalMismatchError(
              "sign-in subject does not match the configured admin",
            )
          }
        }
        principal = { email, subject: sub }
      } catch (err) {
        const kind =
          err instanceof OIDCDiscoveryError ? `discovery:${err.kind}` :
          err instanceof OIDCJWKSError ? `jwks` :
          err instanceof OIDCIdTokenInvalidError ? `idtoken:${err.code}` :
          err instanceof OIDCStateMismatchError ? `state` :
          err instanceof OIDCPrincipalMismatchError ? `principal` :
          err instanceof AdminAuthError ? `auth` :
          `unknown:${err instanceof Error ? err.constructor.name : String(err)}`
        console.error(`[admin-oidc] complete failed: ${kind}`, err instanceof Error ? err.message : err)
        if (
          err instanceof OIDCDiscoveryError ||
          err instanceof OIDCJWKSError ||
          err instanceof OIDCIdTokenInvalidError ||
          err instanceof OIDCStateMismatchError ||
          err instanceof OIDCPrincipalMismatchError
        ) {
          throw new AdminAuthError(OIDC_VERIFICATION_FAILED)
        }
        if (err instanceof AdminAuthError) throw err
        throw new AdminAuthError(OIDC_VERIFICATION_FAILED)
      }
      if (principal === null) throw new AdminAuthError(OIDC_VERIFICATION_FAILED)
      return principal
    },
  }
}
