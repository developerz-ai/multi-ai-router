import { describe, expect, test } from "bun:test"
import {
  parseUsageUrl,
  usageUrlParams,
} from "../../src/routes/usage/usage-url-state"

/** The Usage page's URL contract: #229's links into this page rely on these exact names. */

describe("parseUsageUrl", () => {
  test("no params is the 7 day window with no filters", () => {
    expect(parseUsageUrl({})).toEqual({
      range: "7d",
      filters: { owner: [], tool: [], model: [] },
    })
  })

  test("a named window and repeated filters are read, a single value is a one-item list", () => {
    const parsed = parseUsageUrl({ window: "30d", owner: ["alice", "bob"], tool: "cli" })
    expect(parsed.range).toBe("30d")
    expect(parsed.filters).toEqual({ owner: ["alice", "bob"], tool: ["cli"], model: [] })
  })

  test("empty and duplicate values are dropped", () => {
    expect(parseUsageUrl({ owner: ["alice", "", "alice"] }).filters.owner).toEqual(["alice"])
  })

  test("from and to make a custom range and win over window", () => {
    const from = "2026-10-01T00:00:00.000Z"
    const to = "2026-10-08T00:00:00.000Z"
    expect(parseUsageUrl({ window: "today", from, to }).range).toEqual({ from, to })
  })

  test("a window or range the server would refuse falls back to 7d", () => {
    expect(parseUsageUrl({ window: "century" }).range).toBe("7d")
    expect(parseUsageUrl({ from: "nope", to: "also-nope" }).range).toBe("7d")
    expect(
      parseUsageUrl({ from: "2026-10-08T00:00:00.000Z", to: "2026-10-01T00:00:00.000Z" }).range,
    ).toBe("7d")
    expect(parseUsageUrl({ from: "2026-10-01T00:00:00.000Z" }).range).toBe("7d")
  })

  test("unrelated params are never turned into filters", () => {
    expect(parseUsageUrl({ keyId: "x", utm: "y" }).filters).toEqual({
      owner: [],
      tool: [],
      model: [],
    })
  })
})

describe("usageUrlParams", () => {
  const none = { owner: [], tool: [], model: [] }

  test("the default window and no filters clear every param", () => {
    expect(usageUrlParams("7d", none)).toEqual({
      window: undefined,
      from: undefined,
      to: undefined,
      owner: undefined,
      tool: undefined,
      model: undefined,
    })
  })

  test("a named window clears from and to, a custom range clears window", () => {
    expect(usageUrlParams("30d", none).window).toBe("30d")
    const from = "2026-10-01T00:00:00.000Z"
    const to = "2026-10-08T00:00:00.000Z"
    const custom = usageUrlParams({ from, to }, none)
    expect(custom.window).toBeUndefined()
    expect(custom.from).toBe(from)
    expect(custom.to).toBe(to)
    expect(usageUrlParams("today", none).from).toBeUndefined()
  })

  test("filters are written as lists and round-trip", () => {
    const filters = { owner: ["alice", "bob"], tool: [], model: ["m"] }
    const written = usageUrlParams("today", filters)
    expect(written.owner).toEqual(["alice", "bob"])
    expect(written.tool).toBeUndefined()
    expect(parseUsageUrl(written)).toEqual({ range: "today", filters })
  })
})
