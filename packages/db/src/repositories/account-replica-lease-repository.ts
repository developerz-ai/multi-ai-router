import { sql } from "drizzle-orm"
import type { DatabaseExecutor } from "../client"
import type { AccountReplicaLeaseRow } from "../schema/account-replica-leases"

export interface ReplicaLeaseToken {
  accountId: string
  owner: string
  generation: bigint
}
export interface AccountReplicaLeaseRepository {
  acquire(
    accountId: string,
    owner: string,
    ttlMs: number,
  ): Promise<AccountReplicaLeaseRow | undefined>
  heartbeat(token: ReplicaLeaseToken, ttlMs: number): Promise<boolean>
  ready(token: ReplicaLeaseToken, storageIdentity: string): Promise<boolean>
  drain(token: ReplicaLeaseToken): Promise<boolean>
  release(token: ReplicaLeaseToken): Promise<boolean>
}
function duration(ttlMs: number) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 100 || ttlMs > 300_000)
    throw new RangeError("replica lease TTL must be between 100 and 300000 ms")
  return sql`${ttlMs} * interval '1 millisecond'`
}
function authority(token: ReplicaLeaseToken) {
  return sql`account_id = ${token.accountId}::uuid AND owner = ${token.owner}::uuid
    AND generation = ${token.generation.toString()}::bigint
    AND expires_at > clock_timestamp() AND state <> 'released'`
}

// Each operation touches one row. No deletion API: the generation and storage assignment survive.
export function createAccountReplicaLeaseRepository(
  db: DatabaseExecutor,
): AccountReplicaLeaseRepository {
  const changed = (token: ReplicaLeaseToken, query: ReturnType<typeof sql>) =>
    db.transaction(async (tx) => {
      // An UPDATE can check its predicate before waiting for a row lock. Lock first,
      // then check database time in a new statement so waiting cannot revive expiry.
      await tx.execute(sql`SELECT account_id FROM account_replica_leases
        WHERE account_id = ${token.accountId}::uuid FOR UPDATE`)
      return (await tx.execute(query)).length === 1
    })
  return {
    async acquire(accountId, owner, ttlMs) {
      const [row] = await db.execute<{
        accountId: string
        owner: string
        generation: string
        expiresAt: string
        storageIdentity: string | null
        state: "attaching"
      }>(sql`
        INSERT INTO account_replica_leases (account_id, owner, generation, expires_at, state)
        VALUES (${accountId}::uuid, ${owner}::uuid, 1, clock_timestamp() + ${duration(ttlMs)}, 'attaching')
        ON CONFLICT (account_id) DO UPDATE SET owner = EXCLUDED.owner,
          generation = account_replica_leases.generation + 1,
          expires_at = clock_timestamp() + ${duration(ttlMs)}, state = 'attaching'
        WHERE account_replica_leases.expires_at <= clock_timestamp()
          OR account_replica_leases.state = 'released'
        RETURNING account_id AS "accountId", owner, generation::text,
          expires_at AS "expiresAt", storage_identity AS "storageIdentity", state`)
      return row
        ? {
            ...row,
            generation: BigInt(row.generation),
            expiresAt: new Date(row.expiresAt),
          }
        : undefined
    },
    heartbeat: (token, ttlMs) =>
      changed(
        token,
        sql`
      UPDATE account_replica_leases SET expires_at = clock_timestamp() + ${duration(ttlMs)}
      WHERE ${authority(token)} RETURNING account_id`,
      ),
    ready(token, identity) {
      if (!identity.length || identity.length > 512)
        throw new RangeError("invalid storage identity")
      return changed(
        token,
        sql`UPDATE account_replica_leases SET state = 'ready', storage_identity = ${identity}
        WHERE ${authority(token)} AND state = 'attaching'
          AND (storage_identity IS NULL OR storage_identity = ${identity}) RETURNING account_id`,
      )
    },
    drain: (token) =>
      changed(
        token,
        sql`UPDATE account_replica_leases SET state = 'draining'
      WHERE ${authority(token)} RETURNING account_id`,
      ),
    release: (token) =>
      changed(
        token,
        sql`UPDATE account_replica_leases SET state = 'released', expires_at = clock_timestamp()
      WHERE ${authority(token)} AND state = 'draining' RETURNING account_id`,
      ),
  }
}
