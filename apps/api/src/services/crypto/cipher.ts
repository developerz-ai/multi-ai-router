import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { CredentialDecryptError } from "@multi-ai-router/core"
import {
  AUTH_TAG_BYTES,
  type CredentialEnvelope,
  envelopeHeader,
  formatEnvelope,
  IV_BYTES,
  parseEnvelope,
} from "./envelope"

/**
 * AES-256-GCM over the envelope format in `./envelope.ts`. This is the only
 * place upstream credentials and router key values become ciphertext, and the
 * only place they come back — docs/idea/07-security.md#secrets-at-rest.
 *
 * A factory, not a module-level singleton: nothing here reads `process.env` and
 * nothing happens at import time, so the key is passed in by whoever owns it
 * (`main.ts` via `./fromEnv.ts`) and a test constructs its own instance. Same
 * rule as `createDatabase` in `@multi-ai-router/db`.
 *
 * Authenticated, so a flipped bit anywhere in the record — ciphertext, tag, or
 * the `v1.<keyId>` header that is bound in as additional authenticated data —
 * fails loudly as a `CredentialDecryptError` rather than yielding garbage.
 */

const ALGORITHM = "aes-256-gcm"

export const CREDENTIAL_KEY_BYTES = 32

/** The only key id in service. Rotation is DEFERRED; the envelope already carries the field. */
export const DEFAULT_KEY_ID = "k1"

export interface CredentialCipher {
  /** The key id stamped into every envelope this instance writes. */
  readonly keyId: string
  /** @throws Error when `plaintext` is empty — an empty credential is a caller bug. */
  encrypt(plaintext: string): string
  /** @throws CredentialDecryptError on a malformed, re-labelled, tampered, or foreign record. */
  decrypt(envelope: string): string
}

export interface CredentialCipherOptions {
  /** The decoded 32-byte `ENCRYPTION_KEY`. See `decodeEncryptionKey` in `config/env.ts`. */
  readonly key: Uint8Array
  /** Defaults to {@link DEFAULT_KEY_ID}. */
  readonly keyId?: string
}

export function createCredentialCipher(options: CredentialCipherOptions): CredentialCipher {
  if (options.key.byteLength !== CREDENTIAL_KEY_BYTES) {
    // Deliberately a plain Error, not a `RouterError`: every subclass in core is
    // a request outcome with a fixed HTTP status, and a wrong-sized key is a
    // boot-time configuration failure that no client ever sees. `parseEnv`
    // rejects it first; reaching here means the caller bypassed validation.
    throw new Error(
      `createCredentialCipher: key must be ${CREDENTIAL_KEY_BYTES} bytes, got ${options.key.byteLength}`,
    )
  }

  const key = options.key
  const keyId = options.keyId ?? DEFAULT_KEY_ID
  const header = Buffer.from(envelopeHeader(keyId), "utf8")

  return {
    keyId,

    encrypt: (plaintext) => {
      if (plaintext.length === 0) {
        throw new Error("CredentialCipher.encrypt: refusing to encrypt an empty credential")
      }

      // A fresh 12-byte nonce per record. Reusing one under the same key breaks
      // GCM outright, so it is never derived, cached, or counted — only drawn.
      const iv = randomBytes(IV_BYTES)
      const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES })
      cipher.setAAD(header)
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])

      return formatEnvelope({ keyId, iv, authTag: cipher.getAuthTag(), ciphertext })
    },

    decrypt: (envelope) => {
      const parsed = parseEnvelope(envelope)
      if (parsed.keyId !== keyId) {
        // An unknown key id is refused outright rather than attempted with the
        // one key we hold: a rotated record must be re-encrypted, not guessed at.
        throw new CredentialDecryptError(
          `credential envelope names key id "${parsed.keyId}", which this router does not hold`,
        )
      }
      return open(parsed, key, header)
    },
  }
}

function open(envelope: CredentialEnvelope, key: Uint8Array, header: Buffer): string {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, envelope.iv, {
      authTagLength: AUTH_TAG_BYTES,
    })
    decipher.setAAD(header)
    decipher.setAuthTag(envelope.authTag)
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8")
  } catch (cause) {
    // GCM does not distinguish "wrong key" from "tampered record", and neither
    // do we: both mean the stored bytes are not usable. The message carries no
    // ciphertext, no plaintext, and no key material.
    throw new CredentialDecryptError(
      "credential could not be decrypted: wrong encryption key or a tampered record",
      { cause },
    )
  }
}
