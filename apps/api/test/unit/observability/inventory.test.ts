import { describe, expect, test } from "bun:test"
import { METRIC_INVENTORY_ENV_FIELDS } from "../../../src/config/metric-inventory"
import { countInventory } from "../../../src/observability/inventory"
import { createMetrics } from "../../../src/observability/metrics"
import { type RequestSample, routingView } from "../../../src/services/dataplane"
import type { RoutingSnapshot } from "../../../src/services/routing"

const inventory = { primary: ["model"], secondary: ["model"] }
const request = (overrides: Partial<RequestSample> = {}): RequestSample => ({
  ingressDialect: "openai-chat",
  model: "model",
  keyId: "key",
  outcome: "success",
  durationMs: 100,
  streamed: true,
  requestedPoolIds: ["primary", "secondary"],
  servedPoolId: "secondary",
  ...overrides,
})
const now = new Date("2026-10-03T00:00:00Z")
function snapshot(): RoutingSnapshot {
  return {
    now,
    accounts: [
      routingView({ id: "ordinary", label: "ordinary", provider: "openai-api" }),
      routingView(
        { id: "recovery", label: "recovery", provider: "openai-api" },
        {
          recovery: {
            state: "issued",
            localAvailable: true,
            revision: 1,
            generation: "generation",
            lifecycleVersion: 0,
            nextAllowedAt: now,
            quotaRevisions: {},
          },
        },
      ),
      routingView(
        { id: "foreign", label: "foreign", provider: "openai-api" },
        {
          recovery: {
            state: "issued",
            localAvailable: false,
            revision: 1,
            generation: "other",
            lifecycleVersion: 0,
            nextAllowedAt: now,
            quotaRevisions: {},
          },
        },
      ),
      routingView(
        { id: "disabled", label: "disabled", provider: "openai-api" },
        { status: "disabled" },
      ),
      routingView({ id: "unrelated", label: "unrelated", provider: "openai-api" }),
    ],
    pools: [
      {
        id: "primary",
        name: "primary",
        policy: "priority-failover",
        members: [
          { accountId: "ordinary" },
          { accountId: "recovery" },
          { accountId: "foreign" },
          { accountId: "disabled" },
        ],
      },
    ],
  }
}

describe("configured inventory", () => {
  test("counts ordinary and actual local recovery capacity without changing the snapshot", () => {
    const input = snapshot()
    const before = JSON.stringify(input)
    expect(countInventory(input, inventory)).toEqual([
      { poolId: "primary", model: "model", ordinary: 1, recovery: 1 },
    ])
    expect(JSON.stringify(input)).toBe(before)
  })
  test("reflects deleted membership and rejects unsupported models on the next scrape", () => {
    const metrics = createMetrics({ metricInventory: inventory })
    metrics.setInventory(snapshot())
    expect(metrics.expose()).toContain('pool_id="primary",model="model",admission="ordinary"} 1')
    metrics.setInventory({ ...snapshot(), pools: [] })
    expect(metrics.expose()).not.toContain('pool_id="primary",model="model",admission=')
    metrics.observeRequest(request({ outcome: "upstream_error" }))
    expect(metrics.expose()).not.toContain('pool_id="primary",model="model",result=')
    const empty = snapshot()
    metrics.setInventory({ ...empty, accounts: [] })
    expect(metrics.expose()).toContain('pool_id="primary",model="model",admission="ordinary"} 0')
    const input = snapshot()
    expect(
      countInventory(
        {
          ...input,
          accounts: input.accounts.map((a) => ({ ...a, supportedModels: ["different"] })),
        },
        inventory,
      )[0]?.ordinary,
    ).toBe(0)
  })
  test("aliases, overflow membership and configured quota thresholds match the routing filter", () => {
    const input = snapshot()
    const account = routingView(
      { id: "ordinary", label: "ordinary", provider: "openai-api" },
      {
        supportedModels: ["upstream-model"],
        modelAliases: { model: "upstream-model" },
        quotaWindows: [
          {
            window: "five_hour",
            utilization: 0.8,
            utilizationSource: "continuous",
            resetSource: "unknown",
            lastCheckedAt: now,
          },
        ],
      },
    )
    const pool = input.pools[0]
    if (pool === undefined) throw new Error("fixture pool missing")
    const scoped = {
      ...input,
      accounts: [account],
      pools: [{ ...pool, members: [{ accountId: account.id }], overflowAccountId: account.id }],
    }
    expect(countInventory(scoped, { primary: ["model"] })[0]?.ordinary).toBe(1)
    expect(
      countInventory(scoped, { primary: ["model"] }, { quotaSpentThreshold: 0.75 })[0]?.ordinary,
    ).toBe(0)
  })
  test("terminal results credit each requested pool once and distinguish fallback", () => {
    const metrics = createMetrics({ metricInventory: inventory })
    metrics.observeRequest(request({ requestedPoolIds: ["primary", "primary", "secondary"] }))
    metrics.observeRequest(request({ outcome: "upstream_error" }))
    const text = metrics.expose()
    expect(text).toContain('pool_id="primary",model="model",result="success_elsewhere"} 1')
    expect(text).toContain('pool_id="secondary",model="model",result="success_here"} 1')
    expect(text).toContain('pool_id="primary",model="model",result="failure"} 1')
  })
  test("unknown models and unpooled scopes cannot create pair series", () => {
    const metrics = createMetrics({ metricInventory: inventory })
    metrics.observeRequest(request({ model: "caller-invented" }))
    metrics.observeRequest(request({ requestedPoolIds: ["constructor"] }))
    metrics.observeRequest(request({ model: null }))
    expect(
      metrics
        .expose()
        .split("\n")
        .filter((line) => line.startsWith("router_pool_model_requests_total{")),
    ).toEqual([])
  })
  test("boot rejects malformed, duplicate, oversized or unbounded configuration", () => {
    const field = METRIC_INVENTORY_ENV_FIELDS.METRIC_POOL_MODEL_INVENTORY
    expect(field.parse(JSON.stringify(inventory))).toEqual(inventory)
    for (const text of [
      "no-json",
      "[]",
      '{"p":["m","m"]}',
      '{"p":[]}',
      JSON.stringify({ p: Array.from({ length: 257 }, (_, i) => `m${i}`) }),
    ]) {
      expect(field.safeParse(text).success).toBe(false)
    }
  })
})
