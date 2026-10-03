import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import type { ProviderOAuthFlow } from "../../../providers"
import type { CredentialCipher } from "../../crypto/cipher"
import { awaitOAuthResponse, readOAuthResponse } from "../oauth-response"
import { readStoredOAuth, type StoredOAuthCredential, writeStoredOAuth } from "./credential"

export type RefreshFailure =
  | "no-refresh-token"
  | "unreadable-credential"
  | "unreachable"
  | "refused"
  | "unreadable-tokens"
export type RefreshOutcome =
  | { readonly kind: "success"; readonly row: AccountRow }
  | {
      readonly kind: "skipped"
      readonly reason: "busy" | "superseded" | "aborted" | "not-refreshable" | "unknown-account"
      readonly row?: AccountRow
    }
  | { readonly kind: "failure"; readonly reason: RefreshFailure; readonly observed: AccountRow }

export interface RefreshExchangeDeps {
  readonly accounts: Pick<AccountRepository, "saveRefreshedCredential">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  readonly fetch: (request: Request) => Promise<Response>
  readonly now: () => Date
  readonly timeoutMs: number
}

/** One exchange and one ciphertext CAS. The caller owns distributed exclusion and reread. */
export async function refreshCredential(
  deps: RefreshExchangeDeps,
  row: AccountRow,
  flow: ProviderOAuthFlow,
  signal: AbortSignal,
): Promise<RefreshOutcome> {
  const skipped = (): RefreshOutcome => ({ kind: "skipped", reason: "aborted", row })
  const failed = (reason: RefreshFailure): RefreshOutcome => ({
    kind: "failure",
    reason,
    observed: row,
  })
  if (signal.aborted) return skipped()
  const held = readHeld(deps, row)
  if (held === null) return failed("unreadable-credential")
  if (held.refreshToken === null) return failed("no-refresh-token")
  const built = flow.refresh({ refreshToken: held.refreshToken })
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(deps.timeoutMs)])
  if (signal.aborted) return skipped()
  let response: Response
  try {
    response = await awaitOAuthResponse(
      deps.fetch,
      new Request(built.url, {
        method: built.method,
        headers: { ...built.headers },
        body: built.body,
        signal: requestSignal,
      }),
    )
  } catch {
    return signal.aborted ? skipped() : failed("unreachable")
  }
  let body: unknown
  try {
    body = await readOAuthResponse(response, requestSignal)
  } catch {
    return signal.aborted
      ? skipped()
      : failed(requestSignal.aborted ? "unreachable" : "unreadable-tokens")
  }
  if (!response.ok) {
    return signal.aborted
      ? skipped()
      : failed(transient(response.status) ? "unreachable" : "refused")
  }
  const tokens = flow.readTokens(body, {
    ...(held.providerAccountId === null
      ? {}
      : { previousProviderAccountId: held.providerAccountId }),
    previousAccessToken: held.accessToken,
  })
  if (tokens === null) return signal.aborted ? skipped() : failed("unreadable-tokens")

  // Persist a known rotated grant even if shutdown arrived after its response was parsed.
  const now = deps.now()
  const committed = await deps.accounts.saveRefreshedCredential({
    id: row.id,
    expectedAuthMaterial: row.authMaterial as string,
    authMaterial: deps.cipher.encrypt(
      writeStoredOAuth({
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? held.refreshToken,
        providerAccountId: tokens.providerAccountId ?? held.providerAccountId,
      }),
    ),
    tokenExpiresAt:
      tokens.expiresInSeconds === null
        ? null
        : new Date(now.getTime() + tokens.expiresInSeconds * 1_000),
    now,
  })
  return committed === undefined
    ? { kind: "skipped", reason: "superseded" }
    : { kind: "success", row: committed }
}

function readHeld(deps: RefreshExchangeDeps, row: AccountRow): StoredOAuthCredential | null {
  if (row.authMaterial === null) return null
  try {
    return readStoredOAuth(deps.cipher.decrypt(row.authMaterial))
  } catch {
    return null
  }
}
function transient(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}
