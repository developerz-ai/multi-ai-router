import { describe, expect, test } from "bun:test"
import type { CostBasis } from "@multi-ai-router/db"
import { createMetrics } from "../../../src/observability/metrics"
import { PRICE_TABLE_AS_OF } from "../../../src/services/cost"
import type { UsageRecord } from "../../../src/services/usage"

/**
 * The three series that answer "how much of this deployment's spend can anyone here actually see".
 *
 * Before them the router priced two providers and reported `unknown` for the rest, and nothing
 * exported said so: an operator whose OpenAI traffic was invisible in every cost column had no
 * signal to read but the absence of a number. The point of these assertions is that the *unknown*
 * case is counted as loudly as the priced ones — a coverage ratio computed from only the rows it
 * covers is 100% by construction.
 *
 * "Every attempt" here means every attempt that reached an account. One that never chose a provider
 * is excluded upstream of this counter and has no cost row to be missing from.
 */

const STARTED = new Date("2026-07-27T10:00:00.000Z")
const OVERRIDES_LOADED = "router_price_overrides_loaded_timestamp_seconds"

/** The sample lines of one family, with the `# HELP` and `# TYPE` lines that share its name gone. */
function samplesOf(body: string, name: string): readonly string[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith(`${name} `) || line.startsWith(`${name}{`))
}

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    correlationId: "corr-1",
    clientRequestId: null,
    attempt: 1,
    apiKeyId: "key-1",
    accountId: "acct-1",
    poolId: "pool-1",
    provider: "openai-api",
    sessionKey: null,
    model: "gpt-5.6-sol",
    upstreamModel: "gpt-5.6-sol",
    ingressDialect: "openai-chat",
    egressMode: "passthrough",
    tokensIn: 100,
    tokensOut: 200,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costEstimate: "0.006500",
    costBasis: "metered",
    latencyMs: 120,
    ttfbMs: 30,
    routerOverheadMs: 1,
    outcome: "success",
    streamed: false,
    httpStatus: 200,
    errorClass: null,
    startedAt: STARTED,
    finishedAt: new Date(STARTED.getTime() + 120),
    ...overrides,
  }
}

describe("router_cost_basis_total", () => {
  test("counts a priced attempt under the basis it was priced on", () => {
    const metrics = createMetrics()
    metrics.observeUsage(record())

    expect(metrics.expose()).toContain(
      'router_cost_basis_total{provider="openai-api",model="gpt-5.6-sol",basis="metered"} 1',
    )
  })

  test("counts the unpriced attempt too, which is the whole point", () => {
    // A counter that only moved for priced attempts would report full coverage of whatever it
    // happened to cover, and the spend nobody can see would leave no trace at all.
    const metrics = createMetrics()
    metrics.observeUsage(
      record({
        provider: "openrouter",
        model: "some/model",
        costEstimate: null,
        costBasis: "unknown",
      }),
    )

    expect(metrics.expose()).toContain(
      'router_cost_basis_total{provider="openrouter",model="some/model",basis="unknown"} 1',
    )
  })

  test("keeps notional apart from metered, so no dashboard can sum them", () => {
    const metrics = createMetrics()
    metrics.observeUsage(record({ costBasis: "metered" }))
    metrics.observeUsage(record({ costBasis: "notional" }))

    const body = metrics.expose()
    expect(body).toContain(
      'router_cost_basis_total{provider="openai-api",model="gpt-5.6-sol",basis="metered"} 1',
    )
    expect(body).toContain(
      'router_cost_basis_total{provider="openai-api",model="gpt-5.6-sol",basis="notional"} 1',
    )
  })

  test("the three bases are one label on one series, so a ratio is a division", () => {
    const metrics = createMetrics()
    const bases: readonly CostBasis[] = ["metered", "metered", "notional", "unknown"]
    for (const basis of bases) metrics.observeUsage(record({ costBasis: basis }))

    const counted = metrics
      .expose()
      .split("\n")
      .filter((line) => line.startsWith("router_cost_basis_total{"))
      .map((line) => Number(line.slice(line.lastIndexOf(" ") + 1)))
      .reduce((total, value) => total + value, 0)

    // Every attempt lands exactly once: the denominator of "what fraction is unknown" is the
    // series' own total, not a second counter that could drift from it.
    expect(counted).toBe(bases.length)
  })

  test("a failed attempt is counted as well, so failures cannot hide unpriced traffic", () => {
    const metrics = createMetrics()
    metrics.observeUsage(
      record({
        outcome: "upstream_error",
        httpStatus: 500,
        costEstimate: null,
        costBasis: "unknown",
      }),
    )

    expect(metrics.expose()).toContain('basis="unknown"} 1')
  })

  test("labels by model, so a table gone stale against a renamed family is visible as one model", () => {
    const metrics = createMetrics()
    metrics.observeUsage(record({ model: "gpt-5.6-sol" }))
    metrics.observeUsage(record({ model: "gpt-5.7-sol", costEstimate: null, costBasis: "unknown" }))

    const body = metrics.expose()
    expect(body).toContain('model="gpt-5.6-sol",basis="metered"} 1')
    expect(body).toContain('model="gpt-5.7-sol",basis="unknown"} 1')
  })
})

describe("router_price_table_asof_timestamp_seconds", () => {
  test("exports the day the shipped table was checked, as a Unix timestamp", () => {
    const expected = Date.parse(`${PRICE_TABLE_AS_OF}T00:00:00Z`) / 1_000

    expect(createMetrics().expose()).toContain(
      `router_price_table_asof_timestamp_seconds ${expected}`,
    )
  })

  test("is present before a single request has been served", () => {
    // The table's age is a property of the image, not of its traffic: a deployment serving nothing
    // still has a price table that can be a year stale.
    expect(createMetrics().expose()).toContain("router_price_table_asof_timestamp_seconds")
  })

  test("survives the per-scrape rebuild that clears the account gauges", () => {
    const metrics = createMetrics()
    metrics.setAccounts([{ id: "acct-1", provider: "openai-api", status: "active" }])

    expect(metrics.expose()).toContain("router_price_table_asof_timestamp_seconds")
  })
})

describe("router_price_overrides_loaded_timestamp_seconds", () => {
  test("is absent before the first successful load, rather than reporting the epoch", () => {
    const metrics = createMetrics()
    metrics.setPriceOverridesLoadedAt(null)

    // A zero here reads as "loaded in 1970", which is a staleness alert firing on a deployment that
    // simply has no overrides. Absent says "no load has happened", which is the fact. Asserted as
    // "no sample line at all" rather than "not zero": the `# HELP` and `# TYPE` lines carry the
    // name too, so a substring check would pass on a gauge that was reporting anything.
    expect(samplesOf(metrics.expose(), OVERRIDES_LOADED)).toEqual([])
  })

  test("reports the load time once the book has loaded", () => {
    const metrics = createMetrics()
    const at = new Date("2026-07-27T09:30:00.000Z")
    metrics.setPriceOverridesLoadedAt(at)

    expect(samplesOf(metrics.expose(), OVERRIDES_LOADED)).toEqual([
      `${OVERRIDES_LOADED} ${at.getTime() / 1_000}`,
    ])
  })
})
