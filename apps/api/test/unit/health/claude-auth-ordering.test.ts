import { expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import type { ClaudeAuthStatus } from "../../../src/providers/claude-sdk/login"
import { createClaudeAuthProbe } from "../../../src/services/health/claudeAuthProbe"
import { createMemoryStore } from "../../support/memory-store"

const now = new Date("2026-10-03T00:00:00Z")
const report = (loggedIn: boolean): ClaudeAuthStatus => ({
  loggedIn,
  email: "synthetic@example.test",
  subscriptionType: "pro",
})

async function subject(
  store: ReturnType<typeof createMemoryStore>,
  status: "active" | "needs_reauth" = "active",
) {
  const row = await store.accounts.create(
    { label: "synthetic Claude", provider: "anthropic-oauth", configDir: "/synthetic/config" },
    now,
  )
  if (status === "active") return row
  const next = await store.accounts.updateOperatorAccount({ id: row.id, patch: { status }, now })
  if (next === undefined) throw new Error("missing fixture")
  return next
}

function paused(store: ReturnType<typeof createMemoryStore>) {
  let finish: (value: ClaudeAuthStatus) => void = () => {
    throw new Error("probe not started")
  }
  const answer = new Promise<ClaudeAuthStatus>((resolve) => {
    finish = resolve
  })
  const audit: unknown[] = []
  const probe = createClaudeAuthProbe({
    accounts: store.accounts,
    configDirs: { pathFor: () => "/synthetic/config" },
    cli: { check: async () => answer },
    audit: {
      record: async (event) => {
        audit.push(event)
      },
    },
    now: () => now,
  })
  return { probe, finish, audit }
}

test("confirmed old Claude auth cannot overwrite an operator disable", async () => {
  const store = createMemoryStore()
  const row = await subject(store, "needs_reauth")
  const h = paused(store)
  const checking = h.probe.check(row)
  await store.accounts.disable(row.id, now)
  h.finish(report(true))
  expect((await checking)?.statusChangedTo).toBeNull()
  expect((await store.accounts.findById(row.id))?.status).toBe("disabled")
  expect(h.audit).toEqual([])
})

test("old logged-out NULL-cipher observation cannot repark completed authorization", async () => {
  const store = createMemoryStore()
  const row = await subject(store)
  const h = paused(store)
  const checking = h.probe.check(row)
  await store.accounts.confirmAccountAuthorization({ id: row.id, expected: row, now })
  h.finish(report(false))
  expect((await checking)?.statusChangedTo).toBeNull()
  const current = await store.accounts.findById(row.id)
  expect(current?.status).toBe("active")
  expect(current?.authRecoveryVersion).toBe(1)
  expect(h.audit).toEqual([])
})

test("auth recovery installs committed facts before a failing audit", async () => {
  const store = createMemoryStore()
  const row = await subject(store, "needs_reauth")
  let installed: AccountRow | undefined
  const probe = createClaudeAuthProbe({
    accounts: store.accounts,
    configDirs: { pathFor: () => "/synthetic/config" },
    cli: { check: async () => report(true) },
    mutationCommitted: async (id) => {
      installed = await store.accounts.findById(id)
    },
    audit: {
      record: async () => {
        throw new Error("synthetic audit failure")
      },
    },
    now: () => now,
  })
  await expect(probe.check(row)).rejects.toThrow("synthetic audit failure")
  expect(installed?.status).toBe("active")
  expect(installed?.lifecycleVersion).toBe(row.lifecycleVersion + 1)
  expect(installed?.authRecoveryVersion).toBe(row.authRecoveryVersion + 1)
  expect(installed?.healthRecoveryVersion).toBe(row.healthRecoveryVersion)
})
