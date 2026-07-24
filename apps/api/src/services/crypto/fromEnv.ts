import { decodeEncryptionKey, type Env } from "../../config/env"
import { type CredentialCipher, createCredentialCipher } from "./cipher"

/**
 * The one place `ENCRYPTION_KEY` becomes a cipher. Boot builds a single instance
 * and hands it to whatever needs it; no other module decodes the key again.
 *
 * Kept apart from `./cipher.ts` so the cipher itself stays a pure function of 32
 * bytes and needs no configuration to test.
 */
export function createCredentialCipherFromEnv(env: Pick<Env, "encryptionKey">): CredentialCipher {
  const key = decodeEncryptionKey(env.encryptionKey)
  if (key === null) {
    // Unreachable through `parseEnv`, which rejects a key that does not decode
    // to 32 bytes and exits the process. A plain Error for the same reason
    // `EnvValidationError` is one: no client ever sees a boot failure.
    throw new Error("ENCRYPTION_KEY does not decode to 32 bytes — boot validation was bypassed")
  }
  return createCredentialCipher({ key })
}
