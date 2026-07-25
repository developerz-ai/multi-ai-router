import { describe, expect, test } from "bun:test"
import { createRegistry } from "../../../src/observability"

/**
 * The hand-rolled Prometheus registry — pure, synchronous, no clock and no store. What matters here
 * is the 0.0.4 text contract (a scraper parses it) and the two safety properties the module doc
 * claims: label values can't collide across a separator, and a metric that hits its series ceiling
 * degrades instead of growing without bound.
 */

describe("counters", () => {
  test("HELP and TYPE precede the series, and a bare increment defaults to one", () => {
    const registry = createRegistry()
    const requests = registry.counter({
      name: "router_requests_total",
      help: "Client-facing requests.",
      labels: ["outcome"],
    })

    requests.inc({ outcome: "success" })

    expect(registry.expose()).toBe(
      [
        "# HELP router_requests_total Client-facing requests.",
        "# TYPE router_requests_total counter",
        'router_requests_total{outcome="success"} 1',
        "",
      ].join("\n"),
    )
  })

  test("accumulates across calls and by an explicit amount", () => {
    const registry = createRegistry()
    const tokens = registry.counter({ name: "t", help: "h", labels: ["direction"] })

    tokens.inc({ direction: "input" }, 5)
    tokens.inc({ direction: "input" }, 3)

    expect(registry.expose()).toContain('t{direction="input"} 8')
  })

  test("a negative delta is ignored — a counter never goes backwards", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "c", help: "h", labels: [] })

    c.inc({}, 5)
    c.inc({}, -100)

    expect(registry.expose()).toContain("c 5")
  })

  test("a metric with no labels renders with no braces suffix at all", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "c", help: "h", labels: [] })
    c.inc({})

    expect(registry.expose()).toContain("c 1")
    expect(registry.expose()).not.toContain("c{}")
  })
})

describe("gauges", () => {
  test("set overwrites rather than accumulates, and clear drops every series", () => {
    const registry = createRegistry()
    const accounts = registry.gauge({ name: "g", help: "h", labels: ["status"] })

    accounts.set({ status: "active" }, 3)
    accounts.set({ status: "active" }, 7)
    expect(registry.expose()).toContain('g{status="active"} 7')

    accounts.clear()
    expect(registry.expose()).not.toContain("g{")
  })
})

describe("histograms", () => {
  test("buckets are cumulative, ascending, and +Inf equals the total count", () => {
    const registry = createRegistry()
    const h = registry.histogram({
      name: "router_overhead_seconds",
      help: "h",
      labels: [],
      buckets: [0.1, 0.5, 1],
    })

    h.observe({}, 0.05) // in every bucket
    h.observe({}, 0.3) // in 0.5, 1, +Inf
    h.observe({}, 5) // only +Inf

    const body = registry.expose()
    expect(body).toContain('router_overhead_seconds_bucket{le="0.1"} 1')
    expect(body).toContain('router_overhead_seconds_bucket{le="0.5"} 2')
    expect(body).toContain('router_overhead_seconds_bucket{le="1"} 2')
    expect(body).toContain('router_overhead_seconds_bucket{le="+Inf"} 3')
    expect(body).toContain("router_overhead_seconds_sum 5.35")
    expect(body).toContain("router_overhead_seconds_count 3")
  })

  test("declared out of order, buckets still render ascending", () => {
    const registry = createRegistry()
    const h = registry.histogram({ name: "h", help: "h", labels: [], buckets: [1, 0.1, 0.5] })
    h.observe({}, 0.2)

    const lines = registry
      .expose()
      .split("\n")
      .filter((line) => line.startsWith("h_bucket"))
    expect(lines.map((line) => line.match(/le="([^"]+)"/)?.[1])).toEqual([
      "0.1",
      "0.5",
      "1",
      "+Inf",
    ])
  })

  test("a non-finite observation is dropped rather than corrupting sum or count", () => {
    const registry = createRegistry()
    const h = registry.histogram({ name: "h", help: "h", labels: [], buckets: [1] })

    h.observe({}, Number.NaN)
    h.observe({}, Number.POSITIVE_INFINITY)
    h.observe({}, 1)

    expect(registry.expose()).toContain("h_count 1")
  })
})

describe("label escaping", () => {
  test("a quote and a backslash in a label value are escaped", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "c", help: "h", labels: ["model"] })

    c.inc({ model: 'weird"model\\name' })

    expect(registry.expose()).toContain('c{model="weird\\"model\\\\name"} 1')
  })

  test("a newline in HELP text is escaped, not left to break the exposition", () => {
    const registry = createRegistry()
    registry.counter({ name: "c", help: "two\nlines", labels: [] })

    expect(registry.expose()).toContain("# HELP c two\\nlines")
  })

  test("label values that would collide on a naive separator stay distinct series", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "c", help: "h", labels: ["a", "b"] })

    c.inc({ a: "x y", b: "z" })
    c.inc({ a: "x", b: "y z" })

    const lines = registry
      .expose()
      .split("\n")
      .filter((line) => line.startsWith("c{"))
    expect(lines).toHaveLength(2)
  })

  test("multiple labels render in declared order", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "c", help: "h", labels: ["provider", "account_id"] })

    c.inc({ provider: "anthropic-api", account_id: "acct-1" })

    expect(registry.expose()).toContain('c{provider="anthropic-api",account_id="acct-1"} 1')
  })
})

describe("series cardinality ceiling", () => {
  test("a metric stops creating new series at the ceiling and reports once", () => {
    const seenLimits: string[] = []
    const registry = createRegistry({
      maxSeriesPerMetric: 2,
      onSeriesLimit: (metric) => seenLimits.push(metric),
    })
    const c = registry.counter({ name: "spray", help: "h", labels: ["id"] })

    c.inc({ id: "a" })
    c.inc({ id: "b" })
    c.inc({ id: "c" }) // over the ceiling: dropped
    c.inc({ id: "d" }) // still dropped, callback fires only once

    const lines = registry
      .expose()
      .split("\n")
      .filter((line) => line.startsWith("spray{"))
    expect(lines).toHaveLength(2)
    expect(seenLimits).toEqual(["spray"])
  })

  test("an existing series keeps accepting observations once the ceiling is hit", () => {
    const registry = createRegistry({ maxSeriesPerMetric: 1 })
    const c = registry.counter({ name: "spray", help: "h", labels: ["id"] })

    c.inc({ id: "a" })
    c.inc({ id: "b" }) // dropped: at ceiling
    c.inc({ id: "a" }) // the existing series still accepts

    expect(registry.expose()).toContain('spray{id="a"} 2')
  })

  test("the default ceiling bounds memory even with no options passed", () => {
    const registry = createRegistry()
    const c = registry.counter({ name: "spray", help: "h", labels: ["id"] })
    for (let i = 0; i < 5_000; i++) c.inc({ id: `id-${i}` })

    const lines = registry
      .expose()
      .split("\n")
      .filter((line) => line.startsWith("spray{"))
    expect(lines.length).toBeLessThan(5_000)
  })
})

describe("collectors and registration order", () => {
  test("onCollect callbacks run once per expose, before rendering", () => {
    const registry = createRegistry()
    const g = registry.gauge({ name: "sampled", help: "h", labels: [] })
    let calls = 0
    registry.onCollect(() => {
      calls += 1
      g.set({}, calls)
    })

    registry.expose()
    expect(registry.expose()).toContain("sampled 2")
    expect(calls).toBe(2)
  })

  test("families render in the order they were registered, not alphabetically", () => {
    const registry = createRegistry()
    registry.counter({ name: "zeta", help: "h", labels: [] }).inc({})
    registry.counter({ name: "alpha", help: "h", labels: [] }).inc({})

    const body = registry.expose()
    expect(body.indexOf("zeta")).toBeLessThan(body.indexOf("alpha"))
  })

  test("an empty registry exposes an empty string", () => {
    expect(createRegistry().expose()).toBe("")
  })
})
