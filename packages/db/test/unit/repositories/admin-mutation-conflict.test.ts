import { expect, test } from "bun:test"
import {
  AdminMutationConflictError,
  withAdminMutationRetry,
} from "../../../src/repositories/admin-mutation-conflict"

test("only known reference constraints become admin conflicts through Drizzle causes", async () => {
  const failure = {
    code: "23503",
    constraint_name: "api_key_pools_pool_id_pools_id_fk",
  }
  await expect(
    withAdminMutationRetry(async () => {
      throw new Error("query failed", { cause: failure })
    }),
  ).rejects.toBeInstanceOf(AdminMutationConflictError)
  const unrelated = { code: "23503", constraint_name: "api_key_pools_api_key_id_api_keys_id_fk" }
  await expect(
    withAdminMutationRetry(async () => {
      throw unrelated
    }),
  ).rejects.toBe(unrelated)
})

test("deadlock retries stop after three rolled-back attempts", async () => {
  let calls = 0
  const failure = { code: "40P01" }
  await expect(
    withAdminMutationRetry(async () => {
      calls++
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(calls).toBe(3)
})

test("ordinary failures are never retried", async () => {
  let calls = 0
  const failure = new Error("audit failed")
  await expect(
    withAdminMutationRetry(async () => {
      calls++
      throw failure
    }),
  ).rejects.toBe(failure)
  expect(calls).toBe(1)
})
