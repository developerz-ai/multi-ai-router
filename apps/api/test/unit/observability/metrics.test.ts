import { describe, expect, test } from "bun:test"
import { VERSION } from "@multi-ai-router/core"
import { createMetrics } from "../../../src/observability/metrics"

/**
 * `router_build_info` is the one series that carries no measurement: it exists so a dashboard can
 * say which build produced the numbers beside it. Three things about it are load-bearing and are
 * therefore asserted rather than assumed — the label is the real version, the line is present
 * before a single request has been served, and the per-scrape gauge rebuild does not take it out.
 */

const BUILD_INFO = `router_build_info{version="${VERSION}"} 1`

describe("router_build_info", () => {
  test("names the build this process is, as a gauge of one", () => {
    expect(createMetrics().expose()).toContain(BUILD_INFO)
  })

  test("is already there on a scrape of a router that has served nothing", () => {
    // Registration order is exposition order, and this family is declared first on purpose: it is
    // the line an operator reads before deciding whether the rest of the body is worth reading.
    expect(createMetrics().expose()).toStartWith("# HELP router_build_info ")
  })

  test("survives the per-scrape rebuild that clears the account gauges", () => {
    const metrics = createMetrics()
    metrics.setAccounts([{ id: "acct-1", provider: "anthropic-api", status: "active" }])

    const body = metrics.expose()
    expect(body).toContain(BUILD_INFO)
    expect(body).toContain('router_accounts{provider="anthropic-api",status="active"} 1')
  })
})
