import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import type { Database } from "../../src/client"
import { createUsageHistoryRepository } from "../../src/repositories/usage-history-repository"
import { historyUrl, usageHistoryFixture } from "./usage-history-fixture"

/**
 * A usage summary runs every statement on one repeatable-read snapshot. The injected bound narrows
 * `statement_timeout` for that transaction only, so a summary whose client is gone cannot hold
 * the snapshot past it — and nothing else on the pool inherits the narrower bound.
 */
const fixture = usageHistoryFixture()

/** The live setting as seen inside the snapshot transaction, captured through `transaction`. */
async function settingInside(options: { snapshotStatementTimeoutMs?: number }): Promise<string> {
  const real = fixture.db()
  let inside = ""
  const spying = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop !== "transaction") return Reflect.get(target, prop, receiver)
      return (run: (tx: Database) => Promise<unknown>, config: unknown) =>
        real.transaction(async (tx) => {
          const result = await run(tx as unknown as Database)
          const [row] = await tx.execute<{ value: string }>(
            sql`select current_setting('statement_timeout') as value`,
          )
          inside = row?.value ?? ""
          return result
        }, config as never)
    },
  })
  await createUsageHistoryRepository(spying, options).withSnapshot(async (history) =>
    history.clock(),
  )
  return inside
}

describe.skipIf(!historyUrl)("withSnapshot statement bound", () => {
  test("narrows statement_timeout inside the snapshot only", async () => {
    expect(await settingInside({ snapshotStatementTimeoutMs: 1500 })).toBe("1500ms")
    const [outside] = await fixture
      .db()
      .execute<{ value: string }>(sql`select current_setting('statement_timeout') as value`)
    expect(outside?.value).toBe("1min")
    // Absent, the pool's own bound applies.
    expect(await settingInside({})).toBe("1min")
  })
})
