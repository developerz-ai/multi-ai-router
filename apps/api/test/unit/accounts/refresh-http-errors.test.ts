import { expect, test } from "bun:test"
import { accountRow, harness } from "./refresh-fixtures"

for (const [status, body] of [
  [502, "<html>Bad Gateway</html>"],
  [503, "Service Unavailable"],
] as const) {
  test(`non-JSON HTTP ${status} uses transient retry budget without false parking`, async () => {
    const h = harness([accountRow()], { maxAttempts: 3 })
    h.upstream.respondWith(async () => new Response(body, { status }))
    const initial = await h.refresher.refreshNow("acct-1")
    expect(initial).toMatchObject({ kind: "failure", reason: "unreachable" })
    expect(h.rows[0]?.status).toBe("active")
    expect(h.events).toEqual([])
    expect(h.schedule.delays()).toEqual([1000])
    await h.refresher.sync("acct-1")
    const second = await h.refresher.refreshNow("acct-1")
    expect(second).toMatchObject({ kind: "failure", reason: "unreachable" })
    expect(h.rows[0]?.status).toBe("active")
    expect(h.events).toEqual([])
    expect(h.schedule.delays()[0]).toBeGreaterThanOrEqual(1000)
    await h.refresher.sync("acct-1")
    await h.refresher.refreshNow("acct-1")
    expect(h.rows[0]?.status).toBe("needs_reauth")
    expect(h.events).toHaveLength(1)
    expect(h.upstream.calls()).toBe(3)
    await h.refresher.stop()
  })
}

test("HTTP 200 with invalid JSON remains malformed tokens and parks immediately", async () => {
  const h = harness([accountRow()])
  h.upstream.respondWith(async () => new Response("not-json", { status: 200 }))
  expect(await h.refresher.refreshNow("acct-1")).toMatchObject({
    kind: "failure",
    reason: "unreadable-tokens",
  })
  expect(h.rows[0]?.status).toBe("needs_reauth")
  expect(h.events).toHaveLength(1)
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})
