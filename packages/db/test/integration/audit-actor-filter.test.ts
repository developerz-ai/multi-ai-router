import { describe, expect, test } from "bun:test"
import { createAuditRepository } from "../../src/repositories/audit-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * "Everything this caller changed", newest first (multi-ai-router#456). Like `kind`, the filter is
 * a predicate in SQL before the limit: filtering a page afterwards would return short pages while
 * the actor's older rows sat further back.
 */
const fixture = ownDatabaseFixture("audit_actor")

describe.skipIf(ownDatabaseUrl === "")("audit actor filter", () => {
  test("list and listForSubject filter by actor before the limit, and with kind", async () => {
    const audit = createAuditRepository(fixture.db())
    await audit.append({ kind: "pool.updated", subjectId: "p1", actor: "din@example.test" })
    await audit.append({ kind: "key.revoked", subjectId: "k1", actor: "din@example.test" })
    for (let i = 0; i < 3; i++) {
      await audit.append({ kind: "pool.deleted", subjectId: "p1", actor: "admin-api-token" })
    }
    await audit.append({ kind: "pool.updated", subjectId: "p1" })

    expect((await audit.list(2, { actor: "din@example.test" })).map((row) => row.kind)).toEqual([
      "key.revoked",
      "pool.updated",
    ])
    expect(
      (await audit.list(10, { actor: "din@example.test", kind: "pool.updated" })).map(
        (row) => row.subjectId,
      ),
    ).toEqual(["p1"])
    expect(await audit.list(10, { actor: "DIN@example.test" })).toEqual([])
    expect(
      (await audit.listForSubject("p1", 10, { actor: "din@example.test" })).map((row) => row.kind),
    ).toEqual(["pool.updated"])
    expect(await audit.list(10)).toHaveLength(6)
  })

  // Proves the index can serve the query shape, not that the planner picks it on a small table.
  test("the actor-filtered feed can ride the (actor, created_at) index", async () => {
    const plan = await fixture.get().sql.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off")
      const rows = await tx.unsafe(
        "explain select * from audit_events where actor = 'din@example.test' order by created_at desc limit 5",
      )
      return rows.map((row) => String(Object.values(row)[0])).join("\n")
    })
    expect(plan).toContain("audit_events_actor_created_idx")
  })
})
