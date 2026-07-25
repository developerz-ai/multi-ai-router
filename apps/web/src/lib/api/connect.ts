import { request } from "./client"

// The connect flow, as the console calls it. Backed by `POST /accounts/:id/connect`,
// `POST /accounts/:id/connect/complete`, `POST /accounts/:id/reconnect` and
// `DELETE /accounts/:id/connect`.
//
// **One gesture, two mechanisms.** A Claude subscription is logged in by driving the `claude`
// CLI; every other subscription by an authorization-code flow the router performs itself. The
// console does not know which — `services/accounts/connect/service.ts` picks the backend from the
// provider registry, and both answer the same three calls. Adding a provider must not add a
// branch here (CLAUDE.md non-negotiable 12).
//
// **Nothing in any of these responses carries credential material.** No code, no `state`, no
// verifier, no token. `authorizeUrl` is a public URL the operator is meant to open; that is the
// whole payload. If a field ever appears here that could carry a secret, it is a bug in the API,
// not a field to render carefully.

export type ConnectMode = "connect" | "reconnect"

/**
 * How the authorization value gets back to the router.
 *
 * `paste` is first-class, not a fallback: it is the only mode that works when the router has no
 * reachable `PUBLIC_URL`, and it is the *only* mode the Claude CLI login has at all. `redirect`
 * is offered when the server minted a callback it can actually receive.
 */
export type ConnectCapture = "redirect" | "paste"

export interface ConnectStarted {
  readonly accountId: string
  readonly mode: ConnectMode
  /** Open this. It is the provider's own authorization page — the CLI's, for a Claude sub. */
  readonly authorizeUrl: string
  /** One-shot and short-lived. After this the start is spent and a new one must be begun. */
  readonly expiresAt: string
  /** Which mode the server shaped this start for. The other still works where one exists. */
  readonly capture: ConnectCapture
  /** Absent where the flow has no redirect the router could name — the CLI owns its own. */
  readonly redirectUri?: string
}

export interface ConnectCompleted {
  readonly accountId: string
  readonly mode: ConnectMode
  readonly connected: true
  /** Claude subscriptions only: the credential file on disk needed re-minifying. */
  readonly repaired?: boolean
  /** OAuth flows only: which capture mode delivered the code. */
  readonly capture?: ConnectCapture
}

export interface ConnectCancelled {
  readonly accountId: string
  readonly cancelled: boolean
}

/**
 * Starts a login. `reconnect` is the same call against the same row — the id, the config
 * directory, the pool membership and the usage history all survive, and only the audit kind
 * differs. Which is why re-authorising an account is never "delete and add again".
 */
export function beginConnect(args: {
  readonly id: string
  readonly mode: ConnectMode
}): Promise<ConnectStarted> {
  const path = args.mode === "reconnect" ? "reconnect" : "connect"
  return request<ConnectStarted>({ method: "POST", path: `/accounts/${args.id}/${path}` })
}

/**
 * Hands back whatever the authorization page left behind: the whole callback URL, a bare query
 * string, or the `code#state` shorthand. All three are accepted — refusing two of them would only
 * teach operators to hand-edit credential material before pasting it.
 */
export function completeConnect(args: {
  readonly id: string
  readonly pasted: string
}): Promise<ConnectCompleted> {
  return request<ConnectCompleted>({
    method: "POST",
    path: `/accounts/${args.id}/connect/complete`,
    body: { pasted: args.pasted },
  })
}

/** Abandons a pending login now rather than at its TTL, terminating any subprocess with it. */
export function cancelConnect(id: string): Promise<ConnectCancelled> {
  return request<ConnectCancelled>({ method: "DELETE", path: `/accounts/${id}/connect` })
}
