import { expect, test } from "bun:test"
import { createMetrics } from "../../../src/observability/metrics"

test("local capacity skip has a distinct count and preserves task failure evidence", () => {
  const metrics = createMetrics()
  metrics.observeTask({
    task: "janitor_sweep",
    status: "failed",
    itemsProcessed: 0,
    durationMs: 10,
  })
  metrics.observeTask({
    task: "janitor_sweep",
    status: "skipped_capacity",
    itemsProcessed: 0,
    durationMs: 1,
  })
  const body = metrics.expose()
  expect(body).toContain(
    'router_task_runs_total{task="janitor_sweep",outcome="skipped_capacity"} 1',
  )
  expect(body).toContain('router_task_consecutive_failures{task="janitor_sweep"} 1')
  expect(body).toContain('router_task_duration_seconds_count{task="janitor_sweep"} 1')
  expect(body).not.toContain('router_task_last_success_timestamp_seconds{task="janitor_sweep"}')
})
