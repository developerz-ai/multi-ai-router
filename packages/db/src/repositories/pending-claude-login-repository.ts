import { sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import type { PendingClaudeLoginRow } from "../schema/pending-claude-logins"

export interface PendingClaudeLoginToken {
  accountId: string
  owner: string
  generation: bigint
}
export interface PendingClaudeLoginRepository {
  claim(token: PendingClaudeLoginToken, expiresAt: Date): Promise<boolean>
  find(accountId: string): Promise<PendingClaudeLoginRow | undefined>
  clear(token: PendingClaudeLoginToken): Promise<boolean>
}

type RawPendingClaudeLoginRow = {
  accountId: string
  owner: string
  generation: string
  expiresAt: string
  updatedAt: string
}
function row(raw: RawPendingClaudeLoginRow): PendingClaudeLoginRow {
  return {
    ...raw,
    generation: BigInt(raw.generation),
    expiresAt: new Date(raw.expiresAt),
    updatedAt: new Date(raw.updatedAt),
  }
}
function fencing(token: PendingClaudeLoginToken) {
  return sql`account_id = ${token.accountId}::uuid AND owner = ${token.owner}::uuid
    AND generation = ${token.generation.toString()}::bigint`
}

/** A row's existence is the pending login claim. No paste, state or credential material is stored. */
export function createPendingClaudeLoginRepository(
  db: DatabaseExecutor,
): PendingClaudeLoginRepository {
  return {
    claim(token, expiresAt) {
      if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()))
        throw new RangeError("pending Claude login expiry must be a valid Date")
      return db.transaction(async (tx) => {
        // Lock first: a conditional upsert can otherwise evaluate its predicate before
        // waiting, and a concurrent claim would be judged against a stale generation.
        await tx.execute(sql`SELECT account_id FROM account_pending_claude_logins
          WHERE account_id = ${token.accountId}::uuid FOR UPDATE`)
        const changed = await tx.execute(sql`
          INSERT INTO account_pending_claude_logins (account_id, owner, generation, expires_at)
          VALUES (${token.accountId}::uuid, ${token.owner}::uuid,
            ${token.generation.toString()}::bigint, ${expiresAt.toISOString()}::timestamptz)
          ON CONFLICT (account_id) DO UPDATE SET owner = EXCLUDED.owner,
            generation = EXCLUDED.generation, expires_at = EXCLUDED.expires_at,
            updated_at = clock_timestamp()
          WHERE account_pending_claude_logins.generation <= EXCLUDED.generation
          RETURNING account_id`)
        return changed.length === 1
      })
    },
    async find(accountId) {
      const [found] = await db.execute<RawPendingClaudeLoginRow>(sql`
        SELECT account_id AS "accountId", owner, generation::text,
          expires_at AS "expiresAt", updated_at AS "updatedAt"
        FROM account_pending_claude_logins
        WHERE account_id = ${accountId}::uuid AND expires_at > clock_timestamp()`)
      return found ? row(found) : undefined
    },
    async clear(token) {
      const removed = await db.execute(sql`
        DELETE FROM account_pending_claude_logins WHERE ${fencing(token)} RETURNING account_id`)
      return removed.length === 1
    },
  }
}
