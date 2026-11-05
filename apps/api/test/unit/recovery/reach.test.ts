import { expect, test } from "bun:test"
import { reachableAccounts } from "../../../src/services/dataplane/recovery-reach"
import type { PoolSnapshot } from "../../../src/services/routing"

const NOW = new Date("2026-11-05T12:00:00.000Z")
const key = (id: string, scope: "all" | "pools" | "accounts", extra = {}) => ({
  id,
  scope,
  revoked: false,
  expiresAt: null,
  ...extra,
})
const pool = (id: string, accountIds: string[]) =>
  ({ id, members: accountIds.map((accountId) => ({ accountId })) }) as unknown as PoolSnapshot
const none = { pools: [], accounts: [] }

test("one usable all-scope key reaches every account", () => {
  expect(reachableAccounts([key("k", "all")], none, [], NOW)).toBe("all")
})

test("pool and account scopes reach exactly their members and accounts", () => {
  const reach = reachableAccounts(
    [key("p", "pools"), key("a", "accounts")],
    {
      pools: [{ apiKeyId: "p", poolId: "pool-1" }],
      accounts: [{ apiKeyId: "a", accountId: "listed" }],
    } as never,
    [pool("pool-1", ["member"]), pool("pool-2", ["elsewhere"])],
    NOW,
  )
  expect(reach).toEqual(new Set(["member", "listed"]))
})

test("revoked and expired keys reach nothing, and no keys reach nothing", () => {
  expect(
    reachableAccounts(
      [key("r", "all", { revoked: true }), key("e", "all", { expiresAt: NOW })],
      none,
      [],
      NOW,
    ),
  ).toEqual(new Set())
  expect(reachableAccounts([], none, [pool("pool-1", ["member"])], NOW)).toEqual(new Set())
})
