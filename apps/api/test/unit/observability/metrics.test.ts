import { describe, expect, test } from "bun:test"
import { UNKNOWN_REVISION, VERSION } from "@multi-ai-router/core"
import { createMetrics } from "../../../src/observability/metrics"

/**
 * `router_build_info` is the one series that carries no measurement: it exists so a dashboard can
 * say which build produced the numbers beside it. Four things about it are load-bearing and are
 * therefore asserted rather than assumed — the labels are the real version and the real commit,
 * an unstamped build says so instead of guessing, the line is present before a single request has
 * been served, and the per-scrape gauge rebuild does not take it out.
 */

const BUILD_INFO = `router_build_info{version="${VERSION}",revision="${UNKNOWN_REVISION}"} 1`

describe("router_build_info", () => {
  test("names the build this process is, as a gauge of one", () => {
    expect(createMetrics().expose()).toContain(BUILD_INFO)
  })

  test("carries the revision it was stamped with", () => {
    const body = createMetrics({ revision: "0f1e2d3" }).expose()

    expect(body).toContain(`router_build_info{version="${VERSION}",revision="0f1e2d3"} 1`)
  })

  test("says `unknown` rather than inventing a commit when nothing stamped the build", () => {
    // A local `docker build`, `bun run dev`, a test. Anything but a sha-shaped lie: an operator
    // reading this label chases the commit it names.
    expect(createMetrics().expose()).toContain(`revision="${UNKNOWN_REVISION}"`)
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
