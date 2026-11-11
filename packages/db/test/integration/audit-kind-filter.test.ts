import { describe, expect, test } from "bun:test"
import { createAuditRepository } from "../../src/repositories/audit-repository"
import { ownDatabaseFixture, ownDatabaseUrl } from "./own-database-fixture"

/**
 * The activity feed filtered by kind. The filter must be in SQL, before the limit: filtering a
 * page afterwards returns short (or empty) pages while matching events exist further back.
 */
const fixture = ownDatabaseFixture("audit_kind")

describe.skipIf(ownDatabaseUrl === "")("audit kind filter", () => {
  test("list and listForSubject filter by kind before the limit", async () => {
    const audit = createAuditRepository(fixture.db())
    await audit.append({ kind: "key.create", subjectId: "k1" })
    for (let i = 0; i < 3; i++) await audit.append({ kind: "account.recheck", subjectId: "a1" })
    await audit.append({ kind: "key.revoke", subjectId: "k1" })

    // The two key events sit behind three newer-or-interleaved others; a limit of 2 still finds both.
    expect((await audit.list(2, "key.create")).map((row) => row.kind)).toEqual(["key.create"])
    expect((await audit.list(2, "account.recheck")).map((row) => row.kind)).toEqual([
      "account.recheck",
      "account.recheck",
    ])
    expect(await audit.list(10)).toHaveLength(5)
    expect((await audit.listForSubject("k1", 1, "key.create")).map((row) => row.kind)).toEqual([
      "key.create",
    ])
    expect(await audit.listForSubject("k1", 10)).toHaveLength(2)
    expect(await audit.listForSubject("a1", 10, "key.create")).toEqual([])
  })

  test("the kind-filtered feed can ride the (kind, created_at) index", async () => {
    const plan = await fixture.get().sql.begin(async (tx) => {
      await tx.unsafe("set local enable_seqscan = off")
      const rows = await tx.unsafe(
        "explain select * from audit_events where kind = 'key.create' order by created_at desc limit 5",
      )
      return rows.map((row) => String(Object.values(row)[0])).join("\n")
    })
    expect(plan).toContain("audit_events_kind_created_idx")
  })
})
