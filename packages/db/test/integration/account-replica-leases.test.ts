import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { createDatabase } from "../../src/client"
import { createAccountReplicaLeaseRepository } from "../../src/repositories/account-replica-lease-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

const fixture = ownDatabaseFixture("replica_leases")
describe.skipIf(!ownDatabaseUrl)("replica-lease PostgreSQL fencing", () => {
  test("independent clients race a pre-insert account and retain generations across release", async () => {
    const other = createDatabase({ url: fixture.url(), maxConnections: 1 })
    try {
      const a = createAccountReplicaLeaseRepository(fixture.db())
      const b = createAccountReplicaLeaseRepository(other.db)
      const id = crypto.randomUUID()
      const contenders = await Promise.all([
        a.acquire(id, crypto.randomUUID(), 10000),
        b.acquire(id, crypto.randomUUID(), 10000),
      ])
      expect(contenders.filter(Boolean)).toHaveLength(1)
      const first = contenders.find((row) => row !== undefined)
      if (!first) throw new Error("no owner won")
      expect(first.generation).toBe(1n)
      expect(await a.ready(first, "volume-one")).toBe(true)
      expect(await a.release(first)).toBe(false)
      expect(await a.drain(first)).toBe(true)
      expect(await a.heartbeat(first, 10000)).toBe(true)
      expect(await a.release(first)).toBe(true)
      const next = await b.acquire(id, crypto.randomUUID(), 10000)
      expect(next?.generation).toBe(2n)
      expect(next?.storageIdentity).toBe("volume-one")
      if (!next) throw new Error("handoff failed")
      expect(await a.heartbeat(first, 10000)).toBe(false)
      expect(await a.ready(first, "volume-one")).toBe(false)
      expect(await a.drain(first)).toBe(false)
      expect(await a.release(first)).toBe(false)
      expect(await b.ready(next, "empty-replacement")).toBe(false)
      expect(await b.ready(next, "volume-one")).toBe(true)
    } finally {
      await other.close()
    }
  })
  test("disconnected owner expires and independent successors retain storage and generations", async () => {
    const owner = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const repo = createAccountReplicaLeaseRepository(fixture.db())
    const id = crypto.randomUUID()
    try {
      const first = await createAccountReplicaLeaseRepository(owner.db).acquire(
        id,
        crypto.randomUUID(),
        100,
      )
      if (!first) throw new Error("acquire failed")
      expect(await repo.ready(first, "persistent-volume")).toBe(true)
      await owner.close()
      await fixture.sql()`SELECT pg_sleep(0.15)`
      expect(await repo.heartbeat(first, 10000)).toBe(false)
      expect(await repo.ready(first, "persistent-volume")).toBe(false)
      expect(await repo.drain(first)).toBe(false)
      expect(await repo.release(first)).toBe(false)
      const next = await repo.acquire(id, first.owner, 10000)
      if (!next) throw new Error("expiry handoff failed")
      expect(next.generation).toBe(2n)
      expect(next.storageIdentity).toBe("persistent-volume")
      expect(await repo.ready(first, "persistent-volume")).toBe(false)
      expect(await repo.drain(first)).toBe(false)
      expect(await repo.release(first)).toBe(false)
      expect(await repo.ready(next, "replacement")).toBe(false)
      expect(await repo.drain(next)).toBe(true)
      expect(await repo.release(next)).toBe(true)
      const third = await repo.acquire(id, crypto.randomUUID(), 10000)
      expect(third?.generation).toBe(3n)
      expect(third?.storageIdentity).toBe("persistent-volume")
    } finally {
      await owner.close()
    }
  })
  test("every token field fences writes and draining cannot reactivate readiness", async () => {
    const repo = createAccountReplicaLeaseRepository(fixture.db())
    const first = await repo.acquire(crypto.randomUUID(), crypto.randomUUID(), 10000)
    if (!first) throw new Error("acquire failed")
    for (const invalid of [
      { ...first, owner: crypto.randomUUID() },
      { ...first, accountId: crypto.randomUUID() },
      { ...first, generation: first.generation + 1n },
    ]) {
      expect(await repo.heartbeat(invalid, 10000)).toBe(false)
      expect(await repo.ready(invalid, "volume")).toBe(false)
      expect(await repo.drain(invalid)).toBe(false)
      expect(await repo.release(invalid)).toBe(false)
    }
    expect(await repo.drain(first)).toBe(true)
    expect(await repo.ready(first, "volume")).toBe(false)
    expect(await repo.release(first)).toBe(true)
    expect(await repo.heartbeat(first, 10000)).toBe(false)
    expect(await repo.drain(first)).toBe(false)
  })
  test("generations above Number precision survive release and reacquisition", async () => {
    const repo = createAccountReplicaLeaseRepository(fixture.db())
    const first = await repo.acquire(crypto.randomUUID(), crypto.randomUUID(), 10000)
    if (!first) throw new Error("acquire failed")
    const generation = 9007199254740993n
    await fixture.sql()`UPDATE account_replica_leases SET generation = ${generation.toString()}::bigint
      WHERE account_id = ${first.accountId}::uuid`
    const token = { ...first, generation }
    expect(await repo.heartbeat(first, 10000)).toBe(false)
    expect(await repo.ready(token, "persistent-volume")).toBe(true)
    expect(await repo.drain(token)).toBe(true)
    expect(await repo.release(token)).toBe(true)
    const next = await repo.acquire(first.accountId, first.owner, 10000)
    expect(next?.generation).toBe(generation + 1n)
    expect(next?.storageIdentity).toBe("persistent-volume")
    expect(await repo.heartbeat(token, 10000)).toBe(false)
  })
  test("lock waits cannot renew or activate authority that expired while waiting", async () => {
    const other = createDatabase({ url: fixture.url(), maxConnections: 1 })
    const repo = createAccountReplicaLeaseRepository(other.db)
    try {
      const [session] = await other.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      if (!session) throw new Error("missing mutator session")
      for (const operation of ["heartbeat", "ready", "drain", "release"] as const) {
        const first = await repo.acquire(crypto.randomUUID(), crypto.randomUUID(), 3000)
        if (!first) throw new Error("acquire failed")
        if (operation === "release") expect(await repo.drain(first)).toBe(true)
        const locked = Promise.withResolvers<void>()
        const unlock = Promise.withResolvers<void>()
        let pending: Promise<boolean> | undefined
        const blocker = fixture.db().transaction(async (tx) => {
          await tx.execute(sql`SELECT account_id FROM account_replica_leases
            WHERE account_id = ${first.accountId}::uuid FOR UPDATE`)
          locked.resolve()
          await unlock.promise
        })
        try {
          await Promise.race([locked.promise, blocker])
          pending =
            operation === "heartbeat"
              ? repo.heartbeat(first, 10000)
              : operation === "ready"
                ? repo.ready(first, "volume")
                : repo[operation](first)
          // Observe a real lock wait before expiry, not just a delayed invocation.
          let blockedWhileLive = false
          for (let attempt = 0; attempt < 100; attempt++) {
            const [waiting] = await fixture.sql()<
              {
                blocked: boolean
                live: boolean
              }[]
            >`SELECT cardinality(pg_blocking_pids(${session.pid})) > 0 AS blocked,
              expires_at > clock_timestamp() AS live
              FROM account_replica_leases WHERE account_id = ${first.accountId}::uuid`
            if (waiting?.blocked) {
              blockedWhileLive = waiting.live
              break
            }
            await fixture.sql()`SELECT pg_sleep(0.01)`
          }
          expect(blockedWhileLive).toBe(true)
          await fixture.sql()`SELECT pg_sleep(greatest(0,
            extract(epoch FROM (expires_at - clock_timestamp()))) + 0.05)
            FROM account_replica_leases WHERE account_id = ${first.accountId}::uuid`
          unlock.resolve()
          await blocker
          expect(await pending).toBe(false)
          const [unchanged] = await fixture.sql()<
            {
              state: string
              storage_identity: string | null
            }[]
          >`SELECT state, storage_identity FROM account_replica_leases
            WHERE account_id = ${first.accountId}::uuid`
          expect(unchanged?.state).toBe(operation === "release" ? "draining" : "attaching")
          expect(unchanged?.storage_identity).toBeNull()
          const next = await repo.acquire(first.accountId, crypto.randomUUID(), 10000)
          expect(next?.generation).toBe(first.generation + 1n)
          expect(next?.storageIdentity).toBeNull()
        } finally {
          unlock.resolve()
          await blocker
          await pending
        }
      }
    } finally {
      await other.close()
    }
  }, 20_000)
})
