import type { OAuthTokenRequest } from "../../../providers"
import { awaitOAuthResponse, readOAuthResponse } from "../oauth-response"

export interface IssuerAnswer {
  readonly status: number
  /** Parsed JSON, or `null` when the body was absent or not JSON. */
  readonly body: unknown
  readonly headers: Headers
}

/**
 * One request to an OAuth issuer, bounded by the exchange timeout. `null` means no answer at all —
 * unreachable or timed out — which a poller reads as "ask again", never as a refusal. Never logs:
 * the request body can carry an issuer handle, and the response a code.
 */
export async function sendIssuerRequest(
  deps: {
    readonly fetch: (request: Request) => Promise<Response>
    readonly exchangeTimeoutMs: number
  },
  built: OAuthTokenRequest,
): Promise<IssuerAnswer | null> {
  const signal = AbortSignal.timeout(deps.exchangeTimeoutMs)
  try {
    const response = await awaitOAuthResponse(
      deps.fetch,
      new Request(built.url, {
        method: built.method,
        headers: { ...built.headers },
        body: built.body,
        signal,
      }),
    )
    let body: unknown = null
    try {
      body = await readOAuthResponse(response, signal)
    } catch {
      body = null
    }
    return { status: response.status, body, headers: response.headers }
  } catch {
    return null
  }
}
