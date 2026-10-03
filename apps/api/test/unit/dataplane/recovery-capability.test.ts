import { expect, test } from "bun:test"
import {
  type CurrentRecoveryFacts,
  createRecoveryCapabilities,
  type RecoveryCapability,
} from "../../../src/services/dataplane/recovery-capability"

const expected = {
  lifecycleVersion: 1,
  authMaterial: "synthetic-cipher",
  status: "active" as const,
}
function fixture() {
  const current = new Map<string, CurrentRecoveryFacts>([
    ["a", { ...expected, generation: "g1", recoveryRevision: 1 }],
  ])
  const capabilities = createRecoveryCapabilities("boot", (id) => current.get(id))
  const permit: RecoveryCapability = {
    revision: 1,
    accountId: "a",
    generation: "g1",
    permitId: "p1",
    ownerBootId: "boot",
    ownershipEpoch: 1,
    expected: { ...expected },
    quotaRevisions: { five_hour: 3 },
  }
  return { current, capabilities, permit }
}
test("one final start across 100 requests and duplicate hydration cannot renew", () => {
  const h = fixture()
  expect(h.capabilities.install(h.permit)).toBe(true)
  expect(
    Array.from({ length: 100 }, () => h.capabilities.consume("a", "g1")).filter(Boolean),
  ).toHaveLength(1)
  expect(h.capabilities.install(h.permit)).toBe(false)
  expect(h.capabilities.available("a")).toBeUndefined()
})
test("owner boot, lifecycle, ciphertext, status and current generation fence installation", () => {
  for (const patch of [
    { lifecycleVersion: 2 },
    { authMaterial: "new-cipher" },
    { status: "disabled" as const },
    { status: "exhausted" as const },
    { status: "needs_reauth" as const },
    { generation: "g2" },
    { recoveryRevision: 2 },
  ]) {
    const h = fixture()
    h.current.set("a", { ...expected, generation: "g1", recoveryRevision: 1, ...patch })
    expect(h.capabilities.install(h.permit)).toBe(false)
  }
  const h = fixture()
  expect(h.capabilities.install({ ...h.permit, ownerBootId: "prior-boot" })).toBe(false)
})
test("catalog change while request queued prevents final start", () => {
  const h = fixture()
  h.capabilities.install(h.permit)
  expect(h.capabilities.available("a")).toBeDefined()
  h.current.set("a", {
    ...expected,
    generation: "g1",
    recoveryRevision: 1,
    authMaterial: "rotated",
  })
  expect(h.capabilities.consume("a", "g1")).toBeUndefined()
})
test("newer generation replaces spent permit; late old completion cannot consume new", () => {
  const h = fixture()
  h.capabilities.install(h.permit)
  h.capabilities.consume("a", "g1")
  h.current.set("a", { ...expected, generation: "g2", recoveryRevision: 2 })
  expect(
    h.capabilities.install({ ...h.permit, revision: 2, generation: "g2", permitId: "p2" }),
  ).toBe(true)
  h.capabilities.completed("a", "g1", "p1")
  expect(h.capabilities.consume("a", "g2")?.permitId).toBe("p2")
})
test("deletion plus resource cleanup rejects late issued hydration", () => {
  const h = fixture()
  h.capabilities.install(h.permit)
  h.current.delete("a")
  h.capabilities.forget("a")
  expect(h.capabilities.install(h.permit)).toBe(false)
  expect(h.capabilities.consume("a", "g1")).toBeUndefined()
})
test("installation owns expected facts and captured quota map", () => {
  const h = fixture()
  h.capabilities.install(h.permit)
  const expectedMutable = h.permit.expected as { lifecycleVersion: number }
  expectedMutable.lifecycleVersion = 100
  const revisions = h.permit.quotaRevisions as Record<string, number>
  revisions.five_hour = 100
  expect(h.capabilities.consume("a", "g1")?.quotaRevisions.five_hour).toBe(3)
})
