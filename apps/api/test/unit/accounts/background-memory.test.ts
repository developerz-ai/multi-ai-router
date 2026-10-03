import { expect, test } from "bun:test"
import { accountRow } from "../../support/account-row"
import { createMemoryStore } from "../../support/memory-store"

test("memory background authority mirrors current identity and open recovery fencing", async () => {
  const store = createMemoryStore()
  const row = accountRow()
  store.rows.accounts.push(row)
  const read = () => store.accounts.readEligibleBackgroundAccount(row.id, { ...row })
  expect(await read()).toBe(row)
  for (const state of ["pending", "issued", "uncertain"] as const) {
    store.rows.recoveries.set(row.id, { generation: "g", state })
    expect(await read()).toBeUndefined()
  }
  store.rows.recoveries.set(row.id, { generation: "g", state: "succeeded" })
  expect(await read()).toBe(row)
  expect(
    await store.accounts.readEligibleBackgroundAccount(row.id, { ...row, configDir: "/stale" }),
  ).toBeUndefined()
  row.status = "disabled"
  expect(await read()).toBeUndefined()
  await store.accounts.delete(row.id)
  expect(store.rows.recoveries.has(row.id)).toBe(false)
})

test("failed atomic account mutation restores recovery facts without replacing the shared map", async () => {
  const store = createMemoryStore()
  const row = accountRow()
  store.rows.accounts.push(row)
  const recoveries = store.rows.recoveries
  recoveries.set(row.id, { generation: "original", state: "pending" })
  await expect(
    store.mutations.run({ kind: "pool", id: null, name: "rollback-fixture" }, async (scope) => {
      await scope.accounts.delete(row.id)
      recoveries.set("new", { generation: "uncommitted", state: "issued" })
      throw new Error("audit unavailable")
    }),
  ).rejects.toThrow("audit unavailable")
  expect(store.rows.accounts).toHaveLength(1)
  expect(store.rows.recoveries).toBe(recoveries)
  expect(recoveries.get(row.id)).toEqual({ generation: "original", state: "pending" })
  expect(recoveries.has("new")).toBe(false)
  expect(await store.accounts.readEligibleBackgroundAccount(row.id, row)).toBeUndefined()
})
