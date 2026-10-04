import type { MetricInventory } from "../config/metric-inventory"
import type { RequestSample } from "../services/dataplane"
import {
  evaluateCandidate,
  type RoutingSnapshot,
  resolveScope,
  type SelectionOptions,
} from "../services/routing"
import type { Registry } from "./registry"

/** Scrape-only inspection. It neither reserves permits nor publishes recovery demand. */
export function countInventory(
  snapshot: RoutingSnapshot,
  inventory: MetricInventory,
  options: SelectionOptions = {},
) {
  const poolIds = new Set(snapshot.pools.map((pool) => pool.id))
  const readings: { poolId: string; model: string; ordinary: number; recovery: number }[] = []
  for (const [poolId, models] of Object.entries(inventory)) {
    if (!poolIds.has(poolId)) continue
    for (const model of models) {
      const { groups } = resolveScope(snapshot, {
        sessionKey: "",
        model,
        keyScope: { kind: "pools", poolIds: [poolId] },
      })
      let ordinary = 0
      let recovery = 0
      const seen = new Set<string>()
      for (const group of groups) {
        const members = [...group.members, ...(group.overflow === null ? [] : [group.overflow])]
        for (const member of members) {
          if (seen.has(member.account.id)) continue
          seen.add(member.account.id)
          const verdict = evaluateCandidate(member, model, snapshot.now, options)
          if (!verdict.ok) continue
          if (verdict.candidate.halfOpen) recovery++
          else ordinary++
        }
      }
      readings.push({ poolId, model, ordinary, recovery })
    }
  }
  return readings
}

export function createInventoryMetrics(
  registry: Registry,
  inventory: MetricInventory,
  options: SelectionOptions = {},
) {
  let knownPools = new Set(Object.keys(inventory))
  const requests = registry.counter({
    name: "router_pool_model_requests_total",
    help: "Terminal client requests for configured requested pool/model pairs, by final result.",
    labels: ["pool_id", "model", "result"],
  })
  const available = registry.gauge({
    name: "router_pool_model_available_accounts",
    help: "Replica-local currently selectable accounts for configured pool/model pairs, ordinary or recovery.",
    labels: ["pool_id", "model", "admission"],
  })
  return {
    observe(sample: RequestSample) {
      if (sample.model === null) return
      for (const poolId of new Set(sample.requestedPoolIds ?? [])) {
        if (!knownPools.has(poolId)) continue
        if (!Object.hasOwn(inventory, poolId) || !inventory[poolId]?.includes(sample.model))
          continue
        const result =
          sample.outcome !== "success"
            ? "failure"
            : sample.servedPoolId === poolId
              ? "success_here"
              : "success_elsewhere"
        requests.inc({ pool_id: poolId, model: sample.model, result })
      }
    },
    collect(snapshot: RoutingSnapshot) {
      // Clearing first removes deleted or reconfigured pairs; never retain stale availability.
      available.clear()
      knownPools = new Set(snapshot.pools.map((pool) => pool.id))
      for (const reading of countInventory(snapshot, inventory, options)) {
        const labels = { pool_id: reading.poolId, model: reading.model }
        available.set({ ...labels, admission: "ordinary" }, reading.ordinary)
        available.set({ ...labels, admission: "recovery" }, reading.recovery)
      }
    },
  }
}
