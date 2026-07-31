import { eq } from "drizzle-orm"
import type { Database } from "../client"
import { type AdminCredentialRow, adminCredentials } from "../schema/admin-credentials"

/**
 * The one-row local admin credential. Repositories own SQL; this file is the
 * only place that knows `admin_credentials` is a table.
 *
 * **Hash in, hash out.** `passwordHash` crosses this boundary as an argon2id
 * PHC string and nothing else — the service layer hashes before `upsertHash`
 * and verifies after `get`. This repository never sees the plaintext password,
 * which is the property the redaction tests lean on.
 */
export interface AdminCredentialRepository {
  /** The singleton row, or `undefined` when local password sign-in is off. */
  get(): Promise<AdminCredentialRow | undefined>
  /**
   * Writes the hash, replacing whatever was there. One `INSERT … ON CONFLICT`
   * so a re-run of `bin/admin set-password` — the documented recovery path — is
   * idempotent and can never leave two rows to disagree.
   */
  upsertHash(input: UpsertAdminCredentialInput): Promise<AdminCredentialRow>
  /** Deletes the singleton row. Returns whether one existed to delete. */
  remove(): Promise<boolean>
}

export interface UpsertAdminCredentialInput {
  /** argon2id PHC string. Never a plaintext password. */
  readonly passwordHash: string
  readonly now: Date
}

/**
 * The fixed id of the only row this table ever holds. A constant rather than a
 * uuid because the row is addressed, never listed: single-principal is the
 * product rule, and a random id would pretend otherwise.
 */
export const ADMIN_CREDENTIAL_SINGLETON = "local"

export function createAdminCredentialRepository(db: Database): AdminCredentialRepository {
  return {
    get: async () => {
      const rows = await db
        .select()
        .from(adminCredentials)
        .where(eq(adminCredentials.id, ADMIN_CREDENTIAL_SINGLETON))
        .limit(1)
      return rows[0]
    },

    upsertHash: async (input) => {
      const rows = await db
        .insert(adminCredentials)
        .values({
          id: ADMIN_CREDENTIAL_SINGLETON,
          passwordHash: input.passwordHash,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoUpdate({
          target: adminCredentials.id,
          set: { passwordHash: input.passwordHash, updatedAt: input.now },
        })
        .returning()
      const row = rows[0]
      if (row === undefined) {
        // An `insert ... returning` always yields its row; nothing here is a
        // request outcome, so this is a plain Error rather than a `RouterError`.
        throw new Error("adminCredentialRepository.upsertHash: statement returned no row")
      }
      return row
    },

    remove: async () => {
      const rows = await db
        .delete(adminCredentials)
        .where(eq(adminCredentials.id, ADMIN_CREDENTIAL_SINGLETON))
        .returning({ id: adminCredentials.id })
      return rows.length > 0
    },
  }
}
