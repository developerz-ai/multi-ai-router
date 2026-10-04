import { createHash, randomBytes, randomUUID } from "node:crypto"
import type { AccountRepository, OauthStateRepository } from "@multi-ai-router/db"
import { type AdminResult, invalid, notFound, ok } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"
import {
  bindConsumed,
  connectableAccount,
  type FlowLookup,
  registryFlow,
  STATE_REJECTED,
} from "./oauth-binding"
import {
  completeAuthorization,
  type OAuthCapture,
  type OAuthConnectCompleted,
  type OAuthExchangeDeps,
} from "./oauth-exchange"
import { parseAuthorizationPaste } from "./oauth-paste"

/**
 * Connecting a subscription the router logs in to *itself*: authorization code + PKCE (S256),
 * driven server-side, for any provider whose driver advertises a `ProviderOAuthFlow`. ChatGPT/Codex
 * is the only one today; nothing in this file names it, which is what keeps adding another to one
 * file under `providers/drivers/` (CLAUDE.md non-negotiable 12).
 *
 * **The Claude subscription flow is the opposite case and lives in `./claude.ts`** — its exchange
 * belongs to the `claude` CLI and no token ever crosses back to the router (non-negotiable 1).
 * Here the router holds the token, so here is where every check on the one-shot value lives.
 *
 * **Two capture modes, one exchange.** `begin` mints the `state` and the PKCE verifier and answers
 * with an authorization URL; how the resulting `code` gets back is the only difference:
 *
 * - **redirect** — the provider bounces the browser to `PUBLIC_URL + OAUTH_CALLBACK_PATH` and
 *   `redeem` runs;
 * - **paste** — the operator copies what the address bar holds and `complete` runs.
 *
 * **Every flow shipped today starts in paste mode, `PUBLIC_URL` or not.** A `ProviderOAuthFlow` is a
 * reverse-engineered *first-party* client (CLAUDE.md, "Reverse-engineered flows"), and such a
 * client's registration names only its own loopback (`loopbackRedirectUri`). Sending the router's
 * callback as `redirect_uri` makes the issuer refuse the authorization outright — no code is ever
 * minted, so neither mode can finish. That is what production hit on 2026-10-04: a ChatGPT connect
 * whose authorize URL named `PUBLIC_URL`'s callback. So `begin` always names the loopback and says
 * `paste`; `redeem` stays wired, because the `state` it checks is the same one-shot value and a
 * flow whose client *does* register the router's callback would need only an opt-in on its driver
 * (plus the `PUBLIC_URL`-derived callback address, which nothing passes here any more).
 *
 * Both land in the same private `exchange`, in the same consume-then-check order, because a check
 * only one mode performs is a check an attacker picks the other mode to avoid. Paste is
 * first-class, not a fallback: it is the mode that works with no reachable `PUBLIC_URL` at all,
 * and it stays available in redirect mode too — a callback the browser cannot load still leaves
 * the code in the address bar (docs/idea/03-providers.md, docs/idea/09-deployment.md).
 *
 * **What is at rest, and in what form.** The PKCE `code_verifier` is stored as an AES-256-GCM
 * envelope: it is the half of the exchange an attacker holding a stolen `code` still needs. The
 * `state` is stored as-is, because it is the lookup key a callback presents and a value the
 * database must match cannot also be ciphertext. It carries no meaning, is 256 bits of randomness,
 * is one-shot, expires on `env.retention.oauthStateMinutes`, and is redacted by name out of every
 * log line (`logging/redact.ts`).
 *
 * **Every rejection reads the same.** Unknown, already consumed, expired, unbound, or bound to a
 * different account all answer {@link STATE_REJECTED}. A callback that explains *why* it refused is
 * a probe oracle, and the operator's next move is identical in all five cases: start again
 * (docs/idea/07-security.md#oauth-flow-safety).
 */

/**
 * Where the provider sends the browser back, appended to `PUBLIC_URL`. Exported so the route that
 * serves it and the authorization request that names it cannot drift — and published at
 * `.env.example` and docs/idea/09-deployment.md, so it is an address operators configure against.
 */
export const OAUTH_CALLBACK_PATH = "/admin/accounts/oauth/callback"

/** 256 bits each. The verifier is base64url of 32 bytes, comfortably inside PKCE's 43..128 chars. */
const STATE_BYTES = 32
const VERIFIER_BYTES = 32

export interface OAuthConnectStarted {
  readonly accountId: string
  readonly mode: "connect" | "reconnect"
  /** The provider's authorization URL, already carrying `state` and the S256 challenge. */
  readonly authorizeUrl: string
  readonly expiresAt: string
  /** Which mode this start is shaped for. The other still works — both replay `redirectUri`. */
  readonly capture: OAuthCapture
  /** What the operator will see in the address bar, so the console can say what to copy. */
  readonly redirectUri: string
}

export interface OAuthConnectCancelled {
  readonly accountId: string
  /** False when nothing was pending, which is not an error — the desired state already held. */
  readonly cancelled: boolean
}

/** The redirect's query, as it arrives. Everything is optional because a browser sends anything. */
export interface OAuthCallbackQuery {
  readonly code?: string | undefined
  readonly state?: string | undefined
  readonly error?: string | undefined
}

export interface OAuthConnectService {
  begin(accountId: string, mode: "connect" | "reconnect"): Promise<AdminResult<OAuthConnectStarted>>
  /** Paste capture: the whole callback URL, or the `code#state` shorthand. */
  complete(accountId: string, pasted: string): Promise<AdminResult<OAuthConnectCompleted>>
  /** Redirect capture. No account id — the `state` is what names the row it was bound to. */
  redeem(query: OAuthCallbackQuery): Promise<AdminResult<OAuthConnectCompleted>>
  cancel(accountId: string): Promise<AdminResult<OAuthConnectCancelled>>
}

export interface OAuthConnectDeps extends OAuthExchangeDeps {
  readonly accounts: Pick<
    AccountRepository,
    "findById" | "beginAccountAuthorization" | "cancelAccountAuthorization" | "commitAuthorization"
  >
  readonly states: Pick<OauthStateRepository, "consume">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  /** The one-shot window, in minutes. Config, never a constant — `env.retention.oauthStateMinutes`. */
  readonly stateMinutes: number
  /**
   * Which flow a provider declares; the registry's unless given. Exists so the generic paste and
   * redirect machinery stays testable while every shipped flow is device-only.
   */
  readonly flowFor?: FlowLookup
}

interface Presentation {
  readonly code: string
  readonly state: string
  /** The account the caller claims this belongs to; `null` where only the `state` says. */
  readonly boundTo: string | null
  readonly capture: OAuthCapture
}

export function createOAuthConnectService(deps: OAuthConnectDeps): OAuthConnectService {
  const ttlMs = deps.stateMinutes * 60_000

  const flowFor = deps.flowFor ?? registryFlow
  const connectable = (accountId: string) => connectableAccount(deps.accounts, accountId, flowFor)

  /** Where paste and redirect meet. Consume first, judge second: a wrong guess burns its state. */
  const exchange = async (presented: Presentation): Promise<AdminResult<OAuthConnectCompleted>> => {
    const consumed = await deps.states.consume(presented.state, deps.now())
    const bound = await bindConsumed(deps.accounts, consumed, presented.boundTo, flowFor)
    if (!bound.ok) return bound
    const { row, flow, pending, lifecycleVersion } = bound.value
    // A device-code attempt carries its issuer handle in `nonce` and is redeemed only by polling
    // (`oauth-device.ts`); a code presented against one was never minted for it.
    if (pending.nonce !== null) return invalid(STATE_REJECTED, "state_rejected")
    // A provider that declares a device flow connects by it alone; a code that arrives here for one
    // was minted by a start this build no longer offers.
    if (flow.device !== undefined) return deviceOnly(row.label)

    let codeVerifier: string
    try {
      codeVerifier = deps.cipher.decrypt(pending.codeVerifier)
    } catch {
      // An `ENCRYPTION_KEY` that moved between the start and the callback. Nothing to salvage.
      return invalid(
        "this router can no longer read that pending authorization — start the connect flow again",
        "state_unreadable",
      )
    }

    return completeAuthorization(deps, {
      row,
      flow,
      attemptId: pending.id,
      expectedLifecycleVersion: lifecycleVersion,
      code: presented.code,
      redirectUri: pending.redirectUri ?? flow.loopbackRedirectUri,
      codeVerifier,
      capture: presented.capture,
    })
  }

  return {
    begin: async (accountId, mode) => {
      const account = await connectable(accountId)
      if (!account.ok) return account
      const { row, flow } = account.value
      if (flow.device !== undefined) return deviceOnly(row.label)

      const verifier = randomBytes(VERIFIER_BYTES).toString("base64url")
      const state = randomBytes(STATE_BYTES).toString("base64url")
      // See the module note: the first-party client registers its loopback and nothing else.
      const redirectUri = flow.loopbackRedirectUri
      const expiresAt = new Date(deps.now().getTime() + ttlMs)

      const begun = await deps.accounts.beginAccountAuthorization({
        id: accountId,
        expectedProvider: row.provider,
        attempt: {
          id: randomUUID(),
          state,
          codeVerifier: deps.cipher.encrypt(verifier),
          redirectUri,
          expiresAt,
        },
        now: deps.now(),
      })
      if (begun === undefined) return invalid(STATE_REJECTED, "state_rejected")

      const authorizeUrl = flow.authorizeUrl({
        redirectUri,
        state,
        codeChallenge: createHash("sha256").update(verifier).digest("base64url"),
      })

      return ok({
        accountId,
        mode,
        authorizeUrl: authorizeUrl.toString(),
        expiresAt: expiresAt.toISOString(),
        capture: "paste",
        redirectUri,
      })
    },

    complete: async (accountId, pasted) => {
      const account = await connectable(accountId)
      if (!account.ok) return account
      if (account.value.flow.device !== undefined) return deviceOnly(account.value.row.label)
      const presented = parseAuthorizationPaste(pasted)
      if (presented === null) {
        // Describes the shape, never the value: a paste is credential material while in flight.
        return invalid(
          "paste the whole value the authorization page left in the address bar — the callback URL, or code#state",
          "malformed_paste",
        )
      }
      return exchange({ ...presented, boundTo: accountId, capture: "paste" })
    },

    redeem: async (query) => {
      // A refusal still burns the state: it was presented, and one-shot means once.
      if (query.error !== undefined && query.error !== "") {
        if (query.state !== undefined) await deps.states.consume(query.state, deps.now())
        return invalid(
          "the provider did not authorize this connection — start the connect flow again",
          "authorization_refused",
        )
      }
      const { code, state } = query
      if (code === undefined || code === "" || state === undefined || state === "") {
        return invalid(STATE_REJECTED, "state_rejected")
      }
      return exchange({ code, state, boundTo: null, capture: "redirect" })
    },

    cancel: async (accountId) => {
      const account = await connectable(accountId)
      if (!account.ok) return account
      const cancelled = await deps.accounts.cancelAccountAuthorization({
        id: accountId,
        now: deps.now(),
      })
      if (cancelled === undefined) return notFound(`no account with id "${accountId}"`)
      return ok({ accountId, cancelled: cancelled.cancelled })
    },
  }
}

/**
 * Where a provider's OAuth flow declares a device-code sign-in, that is its only connect method:
 * paste-back needs the browser that approved to hand over a loopback address, which is the thing a
 * remote router cannot ask of anyone (docs/idea/03-providers.md).
 */
function deviceOnly(label: string): AdminResult<never> {
  return invalid(
    `account "${label}" connects with a sign-in code — use "Get a code" in the connect dialog`,
    "device_only",
  )
}
