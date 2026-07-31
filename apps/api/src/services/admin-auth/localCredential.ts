import type { AdminCredentialRepository } from "@multi-ai-router/db"

/**
 * The local admin password: hashing, verification, and the one-row store behind
 * it. This module is the reason the credential is never env-var-shaped — it
 * exists only as an argon2id hash in Postgres, written by `bin/admin
 * set-password` and read by the login route. It is never in `.env`, a compose
 * file, an image layer, a log line, or any API response (issue #52).
 *
 * Hashing is Bun's built-in argon2id (`Bun.password`), not a pinned dependency:
 * the runtime ships it, its defaults (64 MiB, 2 passes, 1 lane) meet the OWASP
 * argon2id floor, and one less native binding is one less supply-chain surface.
 *
 * The repository is the only injected dependency, so the unit test runs the
 * real hash and verify against an in-memory store — no database, no mocks of
 * the hashing itself.
 */

/** Below this a brute-force script barely notices the throttle. The CLI refuses shorter. */
export const LOCAL_PASSWORD_MIN_LENGTH = 12
/** Above this the only thing it buys is argon2 work per attempt. The CLI refuses longer. */
export const LOCAL_PASSWORD_MAX_LENGTH = 128

/**
 * A password the service itself chose, so no operator string is ever a module
 * constant. Its only job is to be something argon2 can spend the same work on.
 */
const DUMMY_PASSWORD = "multi-ai-router-dummy-password-not-a-credential"

export class LocalPasswordPolicyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LocalPasswordPolicyError"
  }
}

export interface LocalAdminCredentials {
  /** Whether the door exists at all — a hash row is present. Off by default. */
  isConfigured(): Promise<boolean>
  /**
   * Constant-work either way: an unconfigured door verifies against a lazily
   * minted dummy hash, so "no credential set" and "wrong password" cost the
   * same argon2 pass and the same wording. The answer is always `false` for
   * the dummy comparison — the work is the point, not the verdict.
   */
  verify(password: string): Promise<boolean>
  /**
   * Hashes and stores a new password, replacing any existing one — the
   * recovery path is re-running this. Throws {@link LocalPasswordPolicyError}
   * on a policy violation; the hash leaves this process only via Postgres.
   */
  set(password: string): Promise<void>
  /** Removes the hash row. Returns whether the door was open. */
  remove(): Promise<boolean>
}

export function localPasswordPolicyProblem(password: string): string | null {
  if (password.length < LOCAL_PASSWORD_MIN_LENGTH) {
    return `must be at least ${LOCAL_PASSWORD_MIN_LENGTH} characters`
  }
  if (password.length > LOCAL_PASSWORD_MAX_LENGTH) {
    return `must be at most ${LOCAL_PASSWORD_MAX_LENGTH} characters`
  }
  return null
}

export async function hashLocalPassword(password: string): Promise<string> {
  return await Bun.password.hash(password, { algorithm: "argon2id" })
}

export function createLocalAdminCredentials(deps: {
  readonly repository: AdminCredentialRepository
  readonly now?: () => Date
}): LocalAdminCredentials {
  const now = deps.now ?? ((): Date => new Date())
  // Minted on first use, not at boot: a deployment that never enables local
  // login pays nothing, and a first failed login pays the mint once rather
  // than every time. Held for the life of the service.
  let dummyHash: Promise<string> | null = null

  return {
    isConfigured: async () => (await deps.repository.get()) !== undefined,

    verify: async (password) => {
      const row = await deps.repository.get()
      if (row === undefined) {
        dummyHash ??= hashLocalPassword(DUMMY_PASSWORD)
        // The verdict is discarded on purpose — this pass exists so an absent
        // credential costs exactly what a wrong password costs.
        await Bun.password.verify(password, await dummyHash)
        return false
      }
      return await Bun.password.verify(password, row.passwordHash)
    },

    set: async (password) => {
      const problem = localPasswordPolicyProblem(password)
      if (problem !== null) throw new LocalPasswordPolicyError(problem)
      await deps.repository.upsertHash({
        passwordHash: await hashLocalPassword(password),
        now: now(),
      })
    },

    remove: async () => await deps.repository.remove(),
  }
}
