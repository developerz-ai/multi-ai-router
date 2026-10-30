import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto"
import { decodeEncryptionKey } from "../../config/env"

/**
 * Seals an upstream's encrypted reasoning (an opaque blob the upstream issued, e.g. a Responses
 * `encrypted_content`) so a client can carry it back on its next turn, and opens it again — only
 * for the account that issued it.
 *
 * Why a seal at all: the blob leaves the router inside a field the client echoes (an Anthropic
 * thinking `signature`), so on the way back it is client input. Opened only when its MAC verifies
 * under *this* account, it is never replayed to an upstream that did not issue it and never
 * forged. Deterministic on purpose: the same blob seals to the same bytes every turn, so the
 * client's resent transcript stays a byte-identical prefix and the upstream prompt cache holds.
 *
 * Format: `mrs1.<base64url(blob)>.<base64url(HMAC-SHA256(key, "mrs1" 0 accountId 0 blob))>`. The
 * key is HKDF-derived from `ENCRYPTION_KEY` under its own label, so it is never the encryption key.
 * The blob itself is already the upstream's ciphertext; the seal authenticates, it does not hide.
 *
 * The type is imported by `services/translate/` through `TranslationContext.reasoningSeal`; the
 * translator decides where a seal travels, this module only decides whether one is genuine.
 */
export interface ReasoningSeal {
  /** The client-carriable form of `encrypted`, bound to this account. */
  seal(encrypted: string): string
  /** The original blob, or null when the value is malformed, altered, or another account's. */
  open(signature: string): string | null
}

export interface ReasoningSealer {
  forAccount(accountId: string): ReasoningSeal
}

const VERSION = "mrs1"
const KEY_INFO = "multi-ai-router/reasoning-seal/v1"
const MAC_BYTES = 32

/** @throws Error when `encryptionKey` is not the 32-byte key `parseEnv` admits. */
export function createReasoningSealer(encryptionKey: string): ReasoningSealer {
  const master = decodeEncryptionKey(encryptionKey)
  if (master === null) {
    // Unreachable through `parseEnv`, which validates the same predicate at boot.
    throw new Error("ENCRYPTION_KEY is not 32 bytes; cannot derive the reasoning seal key")
  }
  const key = Buffer.from(hkdfSync("sha256", master, new Uint8Array(0), KEY_INFO, 32))
  const mac = (accountId: string, blob: string): Buffer =>
    createHmac("sha256", key).update(`${VERSION}\0${accountId}\0${blob}`, "utf8").digest()

  return {
    forAccount(accountId) {
      return {
        seal(encrypted) {
          const payload = Buffer.from(encrypted, "utf8").toString("base64url")
          return `${VERSION}.${payload}.${mac(accountId, encrypted).toString("base64url")}`
        },
        open(signature) {
          const parts = signature.split(".")
          if (parts.length !== 3 || parts[0] !== VERSION) return null
          const [, payload = "", tag = ""] = parts
          if (payload.length === 0) return null
          const given = Buffer.from(tag, "base64url")
          // Re-encoding catches a non-canonical encoding: two spellings of one tag are one tag.
          if (given.length !== MAC_BYTES || given.toString("base64url") !== tag) return null
          const blob = Buffer.from(payload, "base64url")
          if (blob.toString("base64url") !== payload) return null
          const encrypted = blob.toString("utf8")
          return timingSafeEqual(given, mac(accountId, encrypted)) ? encrypted : null
        },
      }
    },
  }
}
