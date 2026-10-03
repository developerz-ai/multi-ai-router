import { expect, test } from "bun:test"
import { accountRow, deferred, harness, tokenResponse, until } from "./refresh-fixtures"

test("committed parking refreshes the catalog before a delayed audit completes", async () => {
  const audited = deferred<void>()
  const release = deferred<void>()
  let coherent = false
  const h = harness(
    [accountRow()],
    {},
    {
      refreshCatalogAfterMutation: async () => {
        coherent = true
      },
      audit: {
        record: async () => {
          audited.resolve()
          await release.promise
        },
      },
    },
  )
  h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
  const flight = h.refresher.refreshNow("acct-1")
  await audited.promise
  expect(h.rows[0]?.status).toBe("needs_reauth")
  expect(coherent).toBe(true)
  release.resolve()
  await flight
})

test("throwing parking audit cannot skip the committed catalog barrier", async () => {
  let barriers = 0
  const h = harness(
    [accountRow()],
    {},
    {
      refreshCatalogAfterMutation: async () => {
        barriers++
      },
      audit: {
        record: async () => {
          throw new Error("audit unavailable")
        },
      },
    },
  )
  h.upstream.respondWith(async () => tokenResponse({ error: "invalid_grant" }, 400))
  await expect(h.refresher.refreshNow("acct-1")).rejects.toThrow("audit unavailable")
  expect(h.rows[0]?.status).toBe("needs_reauth")
  expect(barriers).toBe(1)
})

test("failed active credential coherence retries only the catalog on the configured floor", async () => {
  let barriers = 0
  const h = harness(
    [accountRow()],
    {},
    {
      refreshCatalogAfterMutation: async () => {
        if (++barriers === 1) throw new Error("catalog down")
      },
    },
  )
  expect((await h.refresher.refreshNow("acct-1")).kind).toBe("success")
  expect(h.upstream.calls()).toBe(1)
  const retry = h.scheduled.find((call) => call.delay === 1_000 && !call.cancelled)
  expect(retry).toBeDefined()
  retry?.run()
  await until(() => barriers === 2)
  expect(h.upstream.calls()).toBe(1)
  await h.refresher.stop()
})

test("shutdown cancels a dirty catalog retry without another token exchange", async () => {
  let barriers = 0
  const h = harness(
    [accountRow()],
    {},
    {
      refreshCatalogAfterMutation: async () => {
        barriers++
        throw new Error("catalog down")
      },
    },
  )
  await h.refresher.refreshNow("acct-1")
  const retry = h.scheduled.find((call) => call.delay === 1_000 && !call.cancelled)
  await h.refresher.stop()
  retry?.run()
  expect(barriers).toBe(1)
  expect(h.upstream.calls()).toBe(1)
})
