import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { ProviderOAuthFlow } from "../../../providers"
import type { CredentialCipher } from "../../crypto/cipher"
import { readStoredOAuth, type StoredOAuthCredential, writeStoredOAuth } from "./credential"

/**
 * One refresh: the credential the account holds, presented to the provider's token endpoint, and
 * what came back written onto the row. No timers, no status, no retries — those are the
 * refresher's, and keeping them out is what makes this callable exactly once per attempt.
 *
 * Separate from `../connect/oauth-exchange.ts` for the same reason that file is separate from its
 * own service: they are different halves of the same protocol. The connect exchange spends a
 * one-shot `code` a human just authorized and *replaces* whatever the account held; this one spends
 * a long-lived refresh token the router already has and *renews* it. The request shapes differ too
 * — form-encoded there, JSON here for `openai-oauth` — which is why both ask the driver rather than
 * building a body (`providers/drivers/openai-oauth.ts`).
 *
 * **Nothing here repeats the provider's words.** A token-endpoint error body can quote the refresh
 * token that was just presented, so a refusal is its status class and nothing else.
 */

/**
 * Why a refresh did not produce a token. Only `unreachable` is worth retrying: everything else is
 * the issuer, or this router, saying something a clock will not change.
 */
export type RefreshFailure =
  | "unknown-account"
  | "not-refreshable"
  | "no-refresh-token"
  | "unreadable-credential"
  | "unreachable"
  | "refused"
  | "unreadable-tokens"

export type RefreshOutcome =
  /** `expiresAt` is null when the issuer reported no lifetime — then no timer can be armed. */
  | { readonly ok: true; readonly expiresAt: Date | null }
  | { readonly ok: false; readonly reason: RefreshFailure }

export interface RefreshExchangeDeps {
  readonly accounts: Pick<AccountRepository, "update">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  /** Injected for the same reason the data plane's is: no test may reach a real provider. */
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => Date
  /** How long one token-endpoint call may take. */
  readonly timeoutMs: number
}

export async function refreshCredential(
  deps: RefreshExchangeDeps,
  row: AccountRow,
  flow: ProviderOAuthFlow,
  /** Shutdown. A refresh in flight when the router stops is abandoned, not awaited into a hang. */
  signal: AbortSignal,
): Promise<RefreshOutcome> {
  const held = readHeld(deps, row)
  if (held === null) return { ok: false, reason: "unreadable-credential" }
  if (held.refreshToken === null) return { ok: false, reason: "no-refresh-token" }

  const built = flow.refresh({ refreshToken: held.refreshToken })
  let response: Response
  try {
    response = await deps.fetch(
      new Request(built.url, {
        method: built.method,
        headers: { ...built.headers },
        body: built.body,
        signal: AbortSignal.any([AbortSignal.timeout(deps.timeoutMs), signal]),
      }),
    )
  } catch {
    return { ok: false, reason: "unreachable" }
  }

  // Read and dropped: consuming the body frees the connection, and none of it is repeated onward.
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    return { ok: false, reason: transient(response.status) ? "unreachable" : "refused" }
  }

  // Zod at the boundary, in the driver: a reshaped payload is `null`, never half a token set.
  const tokens = flow.readTokens(body)
  if (tokens === null) return { ok: false, reason: "unreadable-tokens" }

  const expiresAt =
    tokens.expiresInSeconds === null
      ? null
      : new Date(deps.now().getTime() + tokens.expiresInSeconds * 1_000)

  await deps.accounts.update(
    row.id,
    {
      // Rotation is the issuer's choice: a response naming no refresh token leaves the one the
      // account already holds in place. A fresh *authorization* replaces it — see `../connect/`.
      authMaterial: deps.cipher.encrypt(
        writeStoredOAuth({
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken ?? held.refreshToken,
        }),
      ),
      // Null is written, never left stale: an issuer that stopped reporting a lifetime must not
      // leave yesterday's expiry driving tomorrow's timer.
      tokenExpiresAt: expiresAt,
    },
    deps.now(),
  )

  return { ok: true, expiresAt }
}

/** `null` covers all three unreadable cases — no material, a key that moved, or a foreign shape. */
function readHeld(deps: RefreshExchangeDeps, row: AccountRow): StoredOAuthCredential | null {
  if (row.authMaterial === null) return null
  try {
    return readStoredOAuth(deps.cipher.decrypt(row.authMaterial))
  } catch {
    return null
  }
}

/** Retried only where a clock could fix it: the issuer was unavailable, not unwilling. */
function transient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
