import { expect, test } from "bun:test"
import { createSessionDeletionFence } from "../../../src/providers/claude-sdk/session/deletion-fence"

test("read deletion history is bounded under a hung read and freed on settlement", () => {
  const fence = createSessionDeletionFence(2)
  const hung = fence.read()
  for (let i = 0; i < 100; i++) fence.invalidate(`deleted-${i}`)
  expect(fence.retainedDeletions).toBe(2)
  expect(hung.valid("unrelated")).toBe(false)
  const fresh = fence.read()
  expect(fresh.valid("unrelated")).toBe(true)
  fresh.release()
  hung.release()
  expect(fence.retainedDeletions).toBe(0)
  for (let i = 0; i < 100; i++) fence.invalidate(`later-${i}`)
  expect(fence.retainedDeletions).toBe(0)
})

test("known-account lease ownership is scoped and released without tombstones", () => {
  const fence = createSessionDeletionFence(2)
  const a = fence.hold("a")
  const b = fence.hold("b")
  const clear = fence.hold(null)
  fence.invalidate("a")
  expect(a.valid()).toBe(false)
  expect(b.valid()).toBe(true)
  expect(clear.valid()).toBe(true)
  a.release()
  b.release()
  clear.release()
  expect(fence.retainedAccounts).toBe(0)
})
