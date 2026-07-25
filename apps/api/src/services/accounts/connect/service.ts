import type { AccountRepository } from "@multi-ai-router/db"
import { type AdminResult, notFound, ok } from "../../admin/result"
import { describeProvider } from "../providers"
import type { ClaudeConnectService } from "./claude"
import type { OAuthCallbackQuery, OAuthConnectService } from "./oauth"
import type { OAuthCapture } from "./oauth-exchange"

/**
 * One connect surface for two very different logins.
 *
 * A Claude subscription is connected by driving the `claude` CLI, whose exchange the router never
 * sees (`./claude.ts`); every other subscription is connected by an authorization-code flow the
 * router drives itself (`./oauth.ts`). The operator does not press two different buttons for that,
 * and the console must not carry a table of which provider takes which call — so the branch lives
 * here, decided from the provider registry, and the admin plane sees one service.
 *
 * The mechanism differs; the *gesture* does not. Both start with an authorization URL, both accept
 * the value the authorization page leaves behind, and both are one-shot with the same TTL — so
 * `complete` is one call for both rather than one path per provider class, which is the difference
 * between a console that knows about accounts and a console that knows about drivers.
 *
 * `redeem` is the one call with no account id: the redirect callback is named by its `state`, and
 * only the OAuth flow has one. It is here so `AdminServices` carries a single connect service.
 *
 * The extra `findById` per call is deliberate. Passing the row down would couple two backends that
 * currently share nothing, to save one primary-key read on the admin plane — where the connect
 * flow is already about to spawn a subprocess or call a token endpoint.
 */

export type ConnectMode = "connect" | "reconnect"

export interface ConnectStarted {
  readonly accountId: string
  readonly mode: ConnectMode
  readonly authorizeUrl: string
  readonly expiresAt: string
  readonly capture: OAuthCapture
  /** Absent where the flow has no redirect the router could name — the CLI owns its own. */
  readonly redirectUri?: string
}

export interface ConnectCompleted {
  readonly accountId: string
  readonly mode: ConnectMode
  readonly connected: true
  /** Claude subscriptions only: the credential file needed re-minifying (`login/credentials.ts`). */
  readonly repaired?: boolean
  /** OAuth flows only: which capture mode delivered the code. */
  readonly capture?: OAuthCapture
}

export interface ConnectCancelled {
  readonly accountId: string
  readonly cancelled: boolean
}

export interface ConnectService {
  begin(accountId: string, mode: ConnectMode): Promise<AdminResult<ConnectStarted>>
  /** The value the authorization page left behind, whichever flow produced it. */
  complete(accountId: string, pasted: string): Promise<AdminResult<ConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ConnectCancelled>>
  /** The OAuth redirect callback. Bound by `state` alone, so no account id is passed or trusted. */
  redeem(query: OAuthCallbackQuery): Promise<AdminResult<ConnectCompleted>>
  /** Terminates every pending CLI login. Called on shutdown; the OAuth flow holds no process. */
  stop(): void
}

export interface ConnectServiceDeps {
  readonly accounts: Pick<AccountRepository, "findById">
  readonly claude: ClaudeConnectService
  readonly oauth: OAuthConnectService
}

/** The three calls both flows answer. Neither backend implements it by name — they just match. */
interface ConnectBackend {
  begin(accountId: string, mode: ConnectMode): Promise<AdminResult<ConnectStarted>>
  complete(accountId: string, pasted: string): Promise<AdminResult<ConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<ConnectCancelled>>
}

export function createConnectService(deps: ConnectServiceDeps): ConnectService {
  /**
   * Which login this account takes, asked of the provider registry rather than of a list kept
   * here: `requiresConfigDir` is true exactly for the providers whose credentials live in a
   * `CLAUDE_CONFIG_DIR` the Agent SDK owns.
   */
  const backendFor = async (accountId: string): Promise<AdminResult<ConnectBackend>> => {
    const row = await deps.accounts.findById(accountId)
    if (row === undefined) return notFound(`no account with id "${accountId}"`)
    return ok(describeProvider(row.provider).requiresConfigDir ? deps.claude : deps.oauth)
  }

  return {
    begin: async (accountId, mode) => {
      const backend = await backendFor(accountId)
      return backend.ok ? backend.value.begin(accountId, mode) : backend
    },

    complete: async (accountId, pasted) => {
      const backend = await backendFor(accountId)
      return backend.ok ? backend.value.complete(accountId, pasted) : backend
    },

    cancel: async (accountId) => {
      const backend = await backendFor(accountId)
      return backend.ok ? backend.value.cancel(accountId) : backend
    },

    redeem: (query) => deps.oauth.redeem(query),

    stop: () => deps.claude.stop(),
  }
}
