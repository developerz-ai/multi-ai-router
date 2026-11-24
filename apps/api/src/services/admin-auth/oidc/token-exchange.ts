import { AdminAuthError } from "@multi-ai-router/core"
import { ADMIN_LOGIN_FAILED_MESSAGE, AdminAuthUnavailableError } from "../login-outcomes"

export interface TokenExchangeDeps {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  /** The endpoint may have moved: the next sign-in re-discovers rather than waiting out the TTL. */
  readonly onFailure: () => void
}

/** Trades an authorization code for an id_token at the IdP's token endpoint. */
export async function exchangeCode(
  client: {
    readonly clientId: string
    readonly clientSecret: string | null
    readonly redirectUri: string
  },
  tokenEndpoint: string,
  grant: { readonly code: string; readonly codeVerifier: string },
  deps: TokenExchangeDeps,
): Promise<{ id_token: string }> {
  const params = new URLSearchParams()
  params.set("grant_type", "authorization_code")
  params.set("code", grant.code)
  params.set("redirect_uri", client.redirectUri)
  params.set("client_id", client.clientId)
  if (client.clientSecret !== null) params.set("client_secret", client.clientSecret)
  params.set("code_verifier", grant.codeVerifier)

  let res: Response
  try {
    res = await deps.fetch(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    })
  } catch (err) {
    deps.onFailure()
    throw err
  }
  if (!res.ok) {
    deps.onFailure()
    // The status only. A token-endpoint error body quotes the request back — including the
    // authorization code and, on some providers, the client secret — so it never reaches a log.
    const reason = `token_exchange: endpoint returned ${res.status}`
    // A throttled exchange is no verdict on the code it was sent.
    if (res.status === 429 || res.status >= 500) throw new AdminAuthUnavailableError({ reason })
    throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE, { reason })
  }
  const body = (await res.json()) as { id_token?: unknown }
  if (typeof body.id_token !== "string" || body.id_token.length === 0) {
    throw new AdminAuthError(ADMIN_LOGIN_FAILED_MESSAGE, {
      reason: "token_exchange: response carried no id_token",
    })
  }
  return { id_token: body.id_token }
}
