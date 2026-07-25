import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { OAuthTokens, ProviderOAuthFlow } from "../../../providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, invalid, ok } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"

/**
 * Spending an authorized code, and writing what it bought onto the Account.
 *
 * Separate from `./oauth.ts` because it is the half with no `state` in it: by the time anything
 * here runs, the one-shot value has been consumed, the binding checked, and the verifier decrypted.
 * What is left is one call to the provider and one write — and both are the same whichever capture
 * mode delivered the code, which is the property `docs/idea/07-security.md` asks for.
 *
 * **Nothing here repeats the provider's words.** A token-endpoint error body can carry the code
 * that was just presented, so a refusal is reported as its status and nothing else.
 */

export type OAuthCapture = "redirect" | "paste"

export interface OAuthConnectCompleted {
  readonly accountId: string
  /** Derived, not declared: an Account that already held a credential was re-connected. */
  readonly mode: "connect" | "reconnect"
  readonly connected: true
  readonly capture: OAuthCapture
}

export interface OAuthExchangeDeps {
  readonly accounts: Pick<AccountRepository, "update">
  readonly cipher: Pick<CredentialCipher, "encrypt">
  readonly audit: AuditRecorder
  /** Injected for the same reason the data plane's is: no test may reach a real provider. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly exchangeTimeoutMs: number
  readonly now: () => Date
}

export interface AuthorizedCode {
  readonly row: AccountRow
  readonly flow: ProviderOAuthFlow
  readonly code: string
  /**
   * Replayed from the pending row, never rebuilt: the provider binds the code to the exact value
   * the authorization request carried, and `PUBLIC_URL` may have been edited since.
   */
  readonly redirectUri: string
  readonly codeVerifier: string
  readonly capture: OAuthCapture
}

export async function completeAuthorization(
  deps: OAuthExchangeDeps,
  input: AuthorizedCode,
): Promise<AdminResult<OAuthConnectCompleted>> {
  const tokens = await redeemCode(deps, input)
  if (!tokens.ok) return tokens
  const mode = await store(deps, input.row, tokens.value, input.capture)
  return ok({ accountId: input.row.id, mode, connected: true, capture: input.capture })
}

async function redeemCode(
  deps: OAuthExchangeDeps,
  input: AuthorizedCode,
): Promise<AdminResult<OAuthTokens>> {
  const built = input.flow.codeExchange({
    code: input.code,
    redirectUri: input.redirectUri,
    codeVerifier: input.codeVerifier,
  })

  let response: Response
  try {
    response = await deps.fetch(
      new Request(built.url, {
        method: built.method,
        headers: { ...built.headers },
        body: built.body,
        signal: AbortSignal.timeout(deps.exchangeTimeoutMs),
      }),
    )
  } catch {
    return invalid(
      "the provider's token endpoint could not be reached — start the connect flow again",
      "exchange_unreachable",
    )
  }

  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    return invalid(
      `the provider refused the code exchange (HTTP ${response.status}) — start the connect flow again`,
      "exchange_refused",
    )
  }

  // Zod at the boundary, in the driver: a reshaped payload is `null`, never half a token set.
  const tokens = input.flow.readTokens(body)
  if (tokens === null) {
    return invalid(
      "the provider answered with a token set this router cannot use — start the connect flow again",
      "exchange_unreadable",
    )
  }
  return ok(tokens)
}

/** Writes the credential and says which of the two things just happened. */
async function store(
  deps: OAuthExchangeDeps,
  row: AccountRow,
  tokens: OAuthTokens,
  capture: OAuthCapture,
): Promise<"connect" | "reconnect"> {
  const mode = row.authMaterial === null ? "connect" : "reconnect"
  const expiresIn = tokens.expiresInSeconds

  await deps.accounts.update(
    row.id,
    {
      // The shape `services/dataplane/egress/credential.ts` reads back, and nothing more: the
      // `id_token` has done its job by the time the tokens are parsed, and the provider's own
      // account id is re-derived from the access token on every request by the driver.
      authMaterial: deps.cipher.encrypt(
        JSON.stringify({
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken === null ? {} : { refreshToken: tokens.refreshToken }),
        }),
      ),
      // A fresh authorization *replaces* what the Account held, so an issuer that reported no
      // lifetime clears the old expiry rather than leaving a stale timer armed against new tokens.
      tokenExpiresAt:
        expiresIn === null ? null : new Date(deps.now().getTime() + expiresIn * 1_000),
      // `needs_reauth` is the one status a login clears. An Account the operator disabled stays
      // disabled, and connecting is not a way around that.
      ...(row.status === "needs_reauth" ? { status: "active" as const } : {}),
    },
    deps.now(),
  )

  await deps.audit.record({
    kind: mode === "reconnect" ? AUDIT_KINDS.accountReauthorized : AUDIT_KINDS.accountConnected,
    subjectType: AUDIT_SUBJECTS.account,
    subjectId: row.id,
    // Names and flags. There is no field here that could hold a code, a state, or a token.
    detail: { label: row.label, provider: row.provider, capture, previousStatus: row.status },
  })

  return mode
}
