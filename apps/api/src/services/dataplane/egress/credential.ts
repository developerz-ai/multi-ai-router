import { CredentialDecryptError } from "@multi-ai-router/core"
import type { ProviderCredential } from "../../../providers"
import type { CredentialCipher } from "../../crypto/cipher"
import type { RoutableAccount } from "../types"

/**
 * The one place an Account's stored credential becomes plaintext, and it happens inside the
 * outbound attempt. Nothing returns it upward, logs it, or serializes it: upstream credentials
 * cross exactly one boundary (docs/idea/01-architecture.md, dependency rule 9).
 *
 * Two stored forms, distinguished by shape rather than by a flag, because the two are not
 * interchangeable on the Anthropic dialect — an OAuth token on `x-api-key` does not work and a
 * bearer token without the beta header does not either (`providers/auth-headers.ts`).
 *
 * **The Agent-SDK path never reaches here.** A Claude subscription Account holds
 * `authMaterial === null` by construction (`services/accounts/rules.ts`): its credentials live
 * inside the Account's `CLAUDE_CONFIG_DIR` and only the `claude` CLI reads them
 * (docs/idea/11-anthropic-agent-sdk.md §3). That is why the null case below is a hard error and not
 * a "no credential needed" fallback — reaching it means an HTTP attempt was planned for an Account
 * that has nothing to authenticate with, which must fail loudly rather than send an anonymous
 * request upstream.
 */

interface StoredOAuth {
  readonly accessToken?: unknown
  readonly access_token?: unknown
}

const NO_MATERIAL = "account holds no credential material"
const UNREADABLE = "stored credential is not in a form this router recognizes"

/** @throws CredentialDecryptError — the message never carries ciphertext or plaintext. */
export function accountCredential(
  account: RoutableAccount,
  cipher: Pick<CredentialCipher, "decrypt">,
): ProviderCredential {
  if (account.authMaterial === null || account.authMaterial.length === 0) {
    throw new CredentialDecryptError(`account ${account.id}: ${NO_MATERIAL}`)
  }

  const plaintext = cipher.decrypt(account.authMaterial).trim()
  if (plaintext.length === 0) {
    throw new CredentialDecryptError(`account ${account.id}: ${NO_MATERIAL}`)
  }
  if (!plaintext.startsWith("{")) {
    return { kind: "api-key", apiKey: plaintext }
  }

  const token = accessToken(plaintext)
  if (token === null) throw new CredentialDecryptError(`account ${account.id}: ${UNREADABLE}`)
  return { kind: "oauth", accessToken: token }
}

function accessToken(plaintext: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const stored = parsed as StoredOAuth
  const value = stored.accessToken ?? stored.access_token
  return typeof value === "string" && value.length > 0 ? value : null
}
