import { expect, test } from "bun:test"
import { createMetrics } from "../../../src/observability/metrics"

test("binding wait is seconds with no caller-controlled labels; invalid samples are ignored", () => {
  const metrics = createMetrics()
  metrics.observeBindingWait(25)
  metrics.observeBindingWait(0)
  metrics.observeBindingWait(Number.NaN)
  metrics.observeBindingWait(Number.POSITIVE_INFINITY)
  metrics.observeBindingWait(-1)
  const text = metrics.expose()
  expect(text).toContain("router_session_binding_wait_seconds_count 2")
  expect(text).toContain("router_session_binding_wait_seconds_sum 0.025")
  expect(text).toContain('router_session_binding_wait_seconds_bucket{le="0.01"} 1')
})
