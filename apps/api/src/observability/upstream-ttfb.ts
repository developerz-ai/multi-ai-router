import { USAGE_OUTCOME_SUCCESS } from "@multi-ai-router/core"
import type { UsageRecord } from "../services/usage"
import type { Registry } from "./registry"

/**
 * Time to first byte, seconds: a cache-warm answer in a few hundred milliseconds up to a long
 * reasoning model's silence before its first token.
 */
const TTFB_BUCKETS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60, 120] as const

/**
 * `router_upstream_ttfb_seconds`: an account's time to its first byte, by provider and by the
 * model name the router sent it (`upstreamModel`, after the alias map). Beside
 * `router_overhead_seconds` it separates the vendor's first-token latency from the router's.
 *
 * Fed from the usage drain like every attempt series, so it costs a request nothing. Only an
 * attempt that succeeded is observed: `model` is a name an account in this deployment actually
 * served, never a string a client typed at an account that refused it. `label` bounds its length,
 * and the registry's per-metric series ceiling is the backstop.
 */
export function createUpstreamTtfb(registry: Registry, label: (value: string) => string) {
  const ttfb = registry.histogram({
    name: "router_upstream_ttfb_seconds",
    help: "Time from an attempt's start to its account's first relayed byte, by provider and the model sent. Successful attempts only.",
    labels: ["provider", "model"],
    buckets: TTFB_BUCKETS,
  })
  return (record: UsageRecord): void => {
    const ms = record.attemptTtfbMs
    if (record.outcome !== USAGE_OUTCOME_SUCCESS || record.provider === null) return
    if (ms === undefined || ms === null || record.upstreamModel === null) return
    ttfb.observe({ provider: record.provider, model: label(record.upstreamModel) }, ms / 1_000)
  }
}
