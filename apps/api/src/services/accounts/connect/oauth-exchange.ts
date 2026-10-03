import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { OAuthTokens, ProviderOAuthFlow } from "../../../providers"
import { AUDIT_KINDS, AUDIT_SUBJECTS, type AuditRecorder } from "../../admin/audit"
import { type AdminResult, conflict, invalid, ok } from "../../admin/result"
import type { CredentialCipher } from "../../crypto/cipher"
import { awaitOAuthResponse, readOAuthResponse } from "../oauth-response"
import { writeStoredOAuth } from "../refresh/credential"

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
  readonly accounts: Pick<AccountRepository, "commitAuthorization">
  readonly cipher: Pick<CredentialCipher, "encrypt">
  readonly audit: AuditRecorder
  /** Injected for the same reason the data plane's is: no test may reach a real provider. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly exchangeTimeoutMs: number
  readonly now: () => Date
  /**
   * Fired once a token set has landed, so its refresh timer is armed against the new expiry rather
   * than the one the row carried a moment ago (`../refresh/`). Optional, and required never to
   * reject: a schedule that could not be re-armed must not turn a completed login into a failure.
   */
  readonly refreshCatalogAfterMutation: () => Promise<void>
  readonly onCredentialWritten?: (accountId: string) => Promise<void>
}

export interface AuthorizedCode {
  readonly row: AccountRow
  readonly flow: ProviderOAuthFlow
  readonly attemptId: string
  readonly expectedLifecycleVersion: number
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
  return store(deps, input, tokens.value)
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

  const signal = AbortSignal.timeout(deps.exchangeTimeoutMs)
  let response: Response
  try {
    response = await awaitOAuthResponse(
      deps.fetch,
      new Request(built.url, {
        method: built.method,
        headers: { ...built.headers },
        body: built.body,
        signal,
      }),
    )
  } catch {
    return invalid(
      "the provider's token endpoint could not be reached — start the connect flow again",
      "exchange_unreachable",
    )
  }

  let body: unknown
  try {
    body = await readOAuthResponse(response, signal)
  } catch {
    if (signal.aborted)
      return invalid(
        "the provider's token endpoint timed out — start the connect flow again",
        "exchange_unreachable",
      )
    body = null
  }
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

/** The consumed attempt plus lifecycle fences writeback; routine refresh is compatible. */
async function store(
  deps: OAuthExchangeDeps,
  input: AuthorizedCode,
  tokens: OAuthTokens,
): Promise<AdminResult<OAuthConnectCompleted>> {
  const { row, capture } = input
  const mode = row.authMaterial === null ? "connect" : "reconnect"
  const now = deps.now()
  const committed = await deps.accounts.commitAuthorization({
    id: row.id,
    expectedLifecycleVersion: input.expectedLifecycleVersion,
    attemptId: input.attemptId,
    authMaterial: deps.cipher.encrypt(
      writeStoredOAuth({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        providerAccountId: tokens.providerAccountId ?? null,
      }),
    ),
    tokenExpiresAt:
      tokens.expiresInSeconds === null
        ? null
        : new Date(now.getTime() + tokens.expiresInSeconds * 1_000),
    now,
  })
  if (committed === undefined) {
    return conflict(
      "that authorization was superseded — start the connect flow again",
      "authorization_superseded",
    )
  }

  // This code has already been spent. Coherence failure is not a redeem failure.
  let coherent = true
  try {
    await deps.refreshCatalogAfterMutation()
  } catch {
    coherent = false
  }
  try {
    await deps.audit.record({
      kind: mode === "reconnect" ? AUDIT_KINDS.accountReauthorized : AUDIT_KINDS.accountConnected,
      subjectType: AUDIT_SUBJECTS.account,
      subjectId: committed.id,
      detail: {
        label: committed.label,
        provider: committed.provider,
        capture,
        previousStatus: row.status,
      },
    })
  } catch {
    coherent = false
  } finally {
    try {
      await deps.onCredentialWritten?.(committed.id)
    } catch {
      coherent = false
    }
  }
  if (!coherent)
    return conflict(
      "authorization was saved but routing is temporarily unavailable",
      "routing_unavailable",
    )
  return ok({ accountId: committed.id, mode, connected: true, capture })
}
