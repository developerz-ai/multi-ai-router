import { describe, expect, test } from "bun:test"
import {
  resolveUsageFilter,
  unknownQueryParam,
  usageFilterQuery,
} from "../../../src/services/usage-read/filter"
import type { KeyLabel } from "../../../src/services/usage-read/types"

const label = (owner: string | null, tool: string | null): KeyLabel => ({
  name: `${owner}/${tool}`,
  owner,
  ownerKind: owner === null ? null : "person",
  tool,
  prefix: "mar_test",
})
const keys = new Map<string, KeyLabel>([
  ["11111111-1111-4111-8111-111111111111", label("alice", "editor")],
  ["22222222-2222-4222-8222-222222222222", label("alice", "cli")],
  ["33333333-3333-4333-8333-333333333333", label("bob", "editor")],
  ["44444444-4444-4444-8444-444444444444", label("bob", "cli")],
  ["55555555-5555-4555-8555-555555555555", label(null, null)],
])
const parse = (input: unknown) => usageFilterQuery.parse(input)

describe("resolveUsageFilter", () => {
  test("no filter and an empty id set are different things", () => {
    expect(resolveUsageFilter(parse({}), keys)).toEqual({})
    expect(resolveUsageFilter(parse({ owner: ["nobody"] }), keys)).toEqual({ apiKeyIds: [] })
  })

  test("owner and tool resolve to key ids, OR within a dimension", () => {
    expect(resolveUsageFilter(parse({ owner: ["alice"] }), keys).apiKeyIds?.sort()).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ])
    expect(resolveUsageFilter(parse({ owner: ["alice", "bob"] }), keys).apiKeyIds).toHaveLength(4)
  })

  test("AND across owner, tool and keyId is an intersection", () => {
    expect(resolveUsageFilter(parse({ owner: ["bob"], tool: ["editor"] }), keys)).toEqual({
      apiKeyIds: ["33333333-3333-4333-8333-333333333333"],
    })
    expect(
      resolveUsageFilter(
        parse({ owner: ["alice"], keyId: ["44444444-4444-4444-8444-444444444444"] }),
        keys,
      ),
    ).toEqual({ apiKeyIds: [] })
  })

  test("unlabelled keys never match an owner or a tool", () => {
    expect(resolveUsageFilter(parse({ tool: ["editor", "cli"] }), keys).apiKeyIds).not.toContain(
      "55555555-5555-4555-8555-555555555555",
    )
  })

  test("an uppercase keyId is folded and still intersects with an owner", () => {
    const upper = "11111111-1111-4111-8111-111111111111".toUpperCase()
    expect(resolveUsageFilter(parse({ owner: ["alice"], keyId: [upper] }), keys)).toEqual({
      apiKeyIds: ["11111111-1111-4111-8111-111111111111"],
    })
  })

  test("keyId alone passes through even for an id the map does not know", () => {
    expect(
      resolveUsageFilter(parse({ keyId: ["66666666-6666-4666-8666-666666666666"] }), keys),
    ).toEqual({ apiKeyIds: ["66666666-6666-4666-8666-666666666666"] })
  })

  test("model, pool and account pass through unchanged", () => {
    expect(
      resolveUsageFilter(
        parse({
          model: ["m1"],
          poolId: ["77777777-7777-4777-8777-777777777777"],
          accountId: ["88888888-8888-4888-8888-888888888888"],
        }),
        keys,
      ),
    ).toEqual({
      models: ["m1"],
      poolIds: ["77777777-7777-4777-8777-777777777777"],
      accountIds: ["88888888-8888-4888-8888-888888888888"],
    })
  })
})

describe("usageFilterQuery", () => {
  const uuid = "6f1c2b0e-3d4a-4b5c-8d9e-0a1b2c3d4e5f"
  test("ids must be uuids so a malformed one is a 400, never a Postgres error", () => {
    for (const field of ["keyId", "poolId", "accountId"])
      expect(usageFilterQuery.safeParse({ [field]: ["nope"] }).success).toBe(false)
    expect(usageFilterQuery.safeParse({ keyId: [uuid], poolId: [uuid] }).success).toBe(true)
  })
  test("a NUL byte is rejected, and a list is capped at 500", () => {
    expect(usageFilterQuery.safeParse({ model: ["a\u0000b"] }).success).toBe(false)
    expect(usageFilterQuery.safeParse({ owner: ["a\u0000"] }).success).toBe(false)
    expect(usageFilterQuery.safeParse({ model: Array(500).fill("m") }).success).toBe(true)
    expect(usageFilterQuery.safeParse({ model: Array(501).fill("m") }).success).toBe(false)
  })
  test("empty values are rejected rather than read as a filter", () => {
    expect(usageFilterQuery.safeParse({ owner: [""] }).success).toBe(false)
    expect(usageFilterQuery.safeParse({ model: [""] }).success).toBe(false)
  })
})

describe("unknownQueryParam", () => {
  test("accepts the window keys and the six filters, names anything else", () => {
    expect(
      unknownQueryParam([
        "window",
        "from",
        "to",
        "owner",
        "tool",
        "model",
        "keyId",
        "poolId",
        "accountId",
      ]),
    ).toBeUndefined()
    expect(unknownQueryParam(["window", "owners"])).toBe("owners")
    expect(unknownQueryParam(["owner[]"])).toBe("owner[]")
  })
  test("truncates a long name instead of echoing it", () => {
    expect(unknownQueryParam(["x".repeat(500)])).toHaveLength(64)
  })
})
