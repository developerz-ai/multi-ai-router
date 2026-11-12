import type { ProviderId } from "@multi-ai-router/core"
import { opaqueAccountRef } from "../../errors/account-ref"

/**
 * The router's own facts about an answer, as response headers — on the data plane's every answer,
 * success or failure, so a caller learns which upstream served it without parsing a body the
 * router does not own (non-negotiable 10). docs/idea/06-protocol-translation.md#router-response-headers.
 *
 * | Header | Value | When |
 * |---|---|---|
 * | `x-router-request-id` | the request id (`middleware/requestId.ts`) | always |
 * | `x-router-attempts` | upstream attempts this request made, `0` for none | every `/v1` inference answer, and every error the transport renders (`0` for one refused before the dispatcher) |
 * | `x-router-served-model` | the model name the upstream was asked for, after the account's alias map | an account answered |
 * | `x-router-provider` | that account's provider id | an account answered |
 * | `x-router-account` | that account, opaque (`errors/account-ref.ts`) | an account answered |
 * | `x-router-reconnect-needed` | the labels of in-scope accounts selection dropped as `needs-reauth`, each URI-component-encoded, `, `-joined | at least one was dropped, success or failure |
 *
 * "Answered" includes an upstream's own error the router relays: the account that said it is named.
 */
export const ROUTER_REQUEST_ID_HEADER = "x-router-request-id"
export const ROUTER_ATTEMPTS_HEADER = "x-router-attempts"
export const ROUTER_SERVED_MODEL_HEADER = "x-router-served-model"
export const ROUTER_PROVIDER_HEADER = "x-router-provider"
export const ROUTER_ACCOUNT_HEADER = "x-router-account"
export const ROUTER_RECONNECT_HEADER = "x-router-reconnect-needed"

/** The account that produced the answer, as the headers name it. */
export interface ServedBy {
  readonly accountId: string
  readonly provider: ProviderId
  readonly upstreamModel: string
}

export function servedByHeaders(served: ServedBy): Record<string, string> {
  return {
    [ROUTER_SERVED_MODEL_HEADER]: served.upstreamModel,
    [ROUTER_PROVIDER_HEADER]: served.provider,
    [ROUTER_ACCOUNT_HEADER]: opaqueAccountRef(served.accountId),
  }
}

/**
 * Sets headers, copying the response only when its headers are immutable. The body stream is
 * carried by reference either way — nothing is buffered.
 */
export function withHeaders(response: Response, headers: Record<string, string>): Response {
  try {
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value)
    return response
  } catch {
    const copy = new Response(response.body, response)
    for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value)
    return copy
  }
}

/**
 * `x-router-reconnect-needed`, or nothing. The one signal a *served* answer carries that part of the
 * pool is down for want of a person: the body is the upstream's, never touched (non-negotiable 10).
 * Encoded per label because a header value is a byte string and a label is operator-typed text.
 */
export function reconnectHeaders(
  accounts: readonly { readonly label: string }[] | undefined,
): Record<string, string> {
  if (accounts === undefined || accounts.length === 0) return {}
  return {
    [ROUTER_RECONNECT_HEADER]: accounts.map((entry) => encodeURIComponent(entry.label)).join(", "),
  }
}
