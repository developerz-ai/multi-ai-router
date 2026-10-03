import { expect, test } from "bun:test"
import {
  createActiveRequestRegistry,
  RouterShutdownError,
} from "../../../src/services/dataplane/active-requests"

test("capacity is bounded, reusable after release, and admission closes synchronously", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const first = registry.register()
  expect(first).toBeDefined()
  expect(registry.register()).toBeUndefined()
  first?.release()
  first?.release()
  const second = registry.register()
  expect(second).toBeDefined()
  registry.closeAdmission()
  expect(registry.register()).toBeUndefined()
  expect(second?.signal.aborted).toBe(false)
  await registry.stop()
  expect(second?.signal.reason).toBeInstanceOf(RouterShutdownError)
  expect(registry.size).toBe(0)
})
test("all abandonment callbacks run before any abort and a replacement records only the latest phase", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 2 })
  const a = registry.register(),
    b = registry.register()
  if (!a || !b) throw new Error("missing leases")
  const events: string[] = []
  a.setAbandon(() => events.push("obsolete-body"))
  a.setAbandon(() => {
    events.push("upstream-a")
    a.release()
  })
  b.setAbandon(() => events.push("body-b"))
  a.signal.addEventListener("abort", () => events.push("abort-a"))
  b.signal.addEventListener("abort", () => events.push("abort-b"))
  const stopping = registry.stop()
  expect(events).toEqual(["upstream-a", "body-b", "abort-a", "abort-b"])
  expect(registry.stop()).toBe(stopping)
  await stopping
  a.setAbandon(() => events.push("late"))
  await registry.stop()
  expect(events).toHaveLength(4)
})
test("callback errors are reported after all requests settle, without awaiting hung cancellation", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 2 })
  const a = registry.register(),
    b = registry.register()
  if (!a || !b) throw new Error("missing leases")
  let settled = 0,
    aborted = 0
  const failure = new Error("fixture failure")
  a.setAbandon(() => {
    throw failure
  })
  b.setAbandon(() => {
    settled++
    expect(registry.register()).toBeUndefined()
  })
  for (const lease of [a, b])
    lease.signal.addEventListener("abort", () => {
      aborted++
      void new Promise<void>(() => {})
    })
  await expect(registry.stop()).rejects.toMatchObject({ errors: [failure] })
  expect(settled).toBe(1)
  expect(aborted).toBe(2)
  expect(registry.size).toBe(0)
})
test("normally released requests are never abandoned by shutdown", async () => {
  const registry = createActiveRequestRegistry({ maximumEntries: 1 })
  const lease = registry.register()
  let calls = 0
  lease?.setAbandon(() => {
    calls++
  })
  lease?.release()
  await registry.stop()
  expect(calls).toBe(0)
  expect(lease?.signal.aborted).toBe(false)
})
