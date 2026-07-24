import { createHmac } from "node:crypto"
import { decodeEncryptionKey } from "../../config/env"
import { timingSafeEqualStrings } from "./constantTime"

/**
 * The cookie value: an opaque session id plus an HMAC over it, `<id>.<signature>`.
 *
 * The id alone would be enough — it is 256 bits of CSPRNG output and the store is the authority.
 * The signature buys two things anyway: a forged or truncated cookie is rejected on arithmetic
 * before it ever reaches the store, so the store is not a probing oracle and cannot be made to
 * do work by an unauthenticated caller; and if the store is ever swapped for one with a
 * different id space, an id from elsewhere still will not validate here.
 *
 * The signing key is derived from `ENCRYPTION_KEY` rather than being a new env var: it is
 * already required, already 32 bytes of CSPRNG output, and already the secret whose loss is
 * total. Deriving with a domain-separated HMAC means the session key is not the encryption key —
 * one cannot be used against the other.
 */

const SESSION_ID_BYTES = 32
const SIGNING_KEY_INFO = "multi-ai-router/admin-session/v1"

/** HKDF-Expand in the single-block case: one HMAC under the master key over a context label. */
export function deriveSessionSigningKey(encryptionKey: string): Buffer {
  const master = decodeEncryptionKey(encryptionKey)
  if (master === null) {
    // Unreachable through `parseEnv`, which validates the same predicate at boot.
    throw new Error("ENCRYPTION_KEY is not 32 bytes; cannot derive the session signing key")
  }
  return createHmac("sha256", Buffer.from(master)).update(SIGNING_KEY_INFO).digest()
}

export function mintSessionId(): string {
  const bytes = new Uint8Array(SESSION_ID_BYTES)
  crypto.getRandomValues(bytes)
  return Buffer.from(bytes).toString("base64url")
}

export function signSessionId(id: string, signingKey: Buffer): string {
  return `${id}.${sign(id, signingKey)}`
}

/** The id carried by a well-formed, correctly signed cookie value; null for anything else. */
export function parseSignedSessionId(value: string, signingKey: Buffer): string | null {
  const separator = value.lastIndexOf(".")
  if (separator <= 0 || separator === value.length - 1) return null

  const id = value.slice(0, separator)
  const signature = value.slice(separator + 1)
  return timingSafeEqualStrings(signature, sign(id, signingKey)) ? id : null
}

function sign(id: string, signingKey: Buffer): string {
  return createHmac("sha256", signingKey).update(id).digest("base64url")
}
