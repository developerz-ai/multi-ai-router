import type { AdminCredential } from "../../config/env"

/**
 * Admin password verification — argon2id, one parameter set, pinned here and nowhere else
 * (docs/idea/07-security.md#admin-plane).
 *
 * `Bun.password` is Bun's built-in binding to the reference argon2 implementation, so there is
 * no dependency to add, audit, or keep current. Verified against Bun 1.3: `Bun.password.hash`
 * takes `{ algorithm: "argon2id", memoryCost, timeCost }` and emits a PHC string
 * (`$argon2id$v=19$m=…,t=…,p=1$…`); `Bun.password.verify(password, hash, "argon2id")` pins the
 * algorithm rather than trusting the one encoded in the stored hash, which is what stops a
 * hostile `ADMIN_PASSWORD_HASH` from downgrading verification to something cheap.
 *
 * Both credential forms converge here: a plaintext `ADMIN_PASSWORD` is hashed **once, at
 * construction** — i.e. at boot — and the plaintext is never written anywhere. A pre-computed
 * `ADMIN_PASSWORD_HASH` is used as-is. `config/env.ts` has already applied the precedence rule
 * (hash wins); this module never looks at `process.env`.
 */

/** OWASP's argon2id baseline: 19 MiB, 2 passes, 1 lane. `memoryCost` is in KiB. */
export const ARGON2ID_PARAMS = {
  algorithm: "argon2id",
  memoryCost: 19456,
  timeCost: 2,
} as const

export interface PasswordVerifier {
  /** Resolves once the boot-time hash exists. Awaited by boot so login is not the first caller. */
  ready(): Promise<void>
  /** True only for the configured password. Never throws on a malformed stored hash. */
  verify(password: string): Promise<boolean>
}

export function createPasswordVerifier(credential: AdminCredential): PasswordVerifier {
  const hash =
    credential.kind === "hash"
      ? Promise.resolve(credential.value)
      : Bun.password.hash(credential.value, ARGON2ID_PARAMS)

  // Every await below handles the rejection; this only keeps an early failure from surfacing as
  // an unhandled rejection before the first caller arrives.
  hash.catch(() => undefined)

  return {
    async ready() {
      await hash
    },
    async verify(password) {
      try {
        return await Bun.password.verify(password, await hash, ARGON2ID_PARAMS.algorithm)
      } catch {
        // A stored hash we cannot parse is a configuration failure, not an authentication.
        // Failing closed here keeps a corrupt `ADMIN_PASSWORD_HASH` from becoming a 500 that
        // distinguishes itself from a wrong password.
        return false
      }
    },
  }
}
