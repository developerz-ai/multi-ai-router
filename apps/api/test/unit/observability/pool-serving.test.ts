import { expect, test } from "bun:test"
import { createInventoryMetrics } from "../../../src/observability/inventory"
import { createRegistry } from "../../../src/observability/registry"
import { account, pool, snapshot } from "../routing/fixtures"

// 13.14: a pool losing its last serving member was visible only as client errors.
test("router_pool_serving_members counts each pool's active members, every pool, no inventory", () => {
  const registry = createRegistry()
  const metrics = createInventoryMetrics(registry, {})
  metrics.collect(
    snapshot(
      [
        account("a"),
        account("b", { status: "cooling_down" }),
        account("c", { status: "exhausted" }),
      ],
      [pool("team", ["a", "b"]), pool("spent", ["b", "c"])],
    ),
  )
  const body = registry.expose()
  expect(body).toContain('router_pool_serving_members{pool_id="team"} 1')
  expect(body).toContain('router_pool_serving_members{pool_id="spent"} 0')

  // A deleted pool's series goes with it.
  metrics.collect(snapshot([account("a")], [pool("team", ["a"])]))
  expect(registry.expose()).not.toContain('pool_id="spent"')
})
