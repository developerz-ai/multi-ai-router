/**
 * The stored OAuth envelope, read and written in one place.
 *
 * `services/dataplane/egress/credential.ts` reads the same plaintext on the request path, and it
 * only ever needs the access token — a driver has no business seeing a refresh token. The refresher
 * needs both halves and has to write them back, so the *shape* lives here, once, rather than as a
 * `JSON.parse` at each end that could drift into disagreeing about what a stored account holds.
 *
 * **Plaintext in, plaintext out.** Encryption belongs to the caller: this module never touches the
 * cipher, so nothing here can be handed ciphertext by accident and nothing here logs.
 *
 * Both spellings are accepted on read for the same reason the egress reader accepts both — a token
 * set pasted by an operator carries the provider's own `snake_case` — while writes are always
 * `camelCase`, so the router's own rows have exactly one form.
 */

export interface StoredOAuthCredential {
  readonly accessToken: string
  /**
   * `null` when the authorization never earned one (no `offline_access`), which is what makes an
   * account unrefreshable rather than merely stale: there is nothing to present.
   */
  readonly refreshToken: string | null
}

interface StoredShape {
  readonly accessToken?: unknown
  readonly access_token?: unknown
  readonly refreshToken?: unknown
  readonly refresh_token?: unknown
}

/** `null` for anything this router cannot read back as a token set. Never throws, never partial. */
export function readStoredOAuth(plaintext: string): StoredOAuthCredential | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null

  const stored = parsed as StoredShape
  const accessToken = text(stored.accessToken ?? stored.access_token)
  if (accessToken === null) return null
  return { accessToken, refreshToken: text(stored.refreshToken ?? stored.refresh_token) }
}

/** Compact and key-ordered, so a re-encrypted row differs only where the tokens differ. */
export function writeStoredOAuth(credential: StoredOAuthCredential): string {
  return JSON.stringify({
    accessToken: credential.accessToken,
    ...(credential.refreshToken === null ? {} : { refreshToken: credential.refreshToken }),
  })
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null
}
