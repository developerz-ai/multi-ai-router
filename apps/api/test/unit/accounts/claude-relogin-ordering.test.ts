import { expect, test } from "bun:test"
import type { AccountStatus } from "@multi-ai-router/core"
import { createClaudeConnectService } from "../../../src/services/accounts"
import { createAuditRecorder } from "../../../src/services/admin"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"

const NOW = new Date("2026-10-03T16:00:00Z")
const STATE = "synthetic-login-state"

async function completeAfter(
  change: (store: ReturnType<typeof createMemoryStore>, id: string) => Promise<void>,
) {
  const store = createMemoryStore()
  const row = await store.accounts.create(
    { label: "synthetic Claude", provider: "anthropic-oauth" },
    NOW,
  )
  const configDirs = createMemoryConfigDirs()
  row.configDir = configDirs.dirs.pathFor(row.id)
  const audit = createAuditRecorder(store.audit)
  const events: string[] = []
  const connect = createClaudeConnectService({
    accounts: store.accounts,
    configDirs: configDirs.dirs,
    login: {
      start: async () => ({
        authorizeUrl: "https://example.test/authorize",
        state: STATE,
        submit: async () => {},
        cancel: () => {},
        exited: Promise.resolve(),
        cancelAsync: async () => {},
      }),
    },
    credentials: {
      settle: async () => {
        await change(store, row.id)
        return "compact"
      },
    },
    audit: {
      record: async (input) => {
        events.push(input.kind)
        await audit.record(input)
      },
    },
    refreshCatalog: async () => {
      events.push("catalog")
    },
    now: () => NOW,
    pendingLoginMinutes: 10,
  })
  expect((await connect.begin(row.id, "reconnect")).ok).toBe(true)
  events.length = 0
  const result = await connect.complete(row.id, `synthetic-code#${STATE}`)
  connect.stop()
  return { result, events, store, row: await store.accounts.findById(row.id) }
}

for (const status of ["needs_reauth", "exhausted", "cooling_down"] as const) {
  test(`CLI completion accepts background ${status} without overriding billing/cooldown`, async () => {
    const h = await completeAfter(async (store, id) => {
      const current = await store.accounts.findById(id)
      if (current === undefined) throw new Error("missing fixture")
      await store.accounts.transitionObservedStatus({
        id,
        expected: current,
        status,
        now: NOW,
      })
    })
    const expected: AccountStatus = status === "needs_reauth" ? "active" : status
    expect(h.result.ok).toBe(true)
    expect(h.row).toMatchObject({
      status: expected,
      lifecycleVersion: 1,
      authRecoveryVersion: 1,
      healthRecoveryVersion: 0,
      authMaterial: null,
    })
    expect(h.events).toEqual(["catalog", "account.reauthorized"])
    const audit = h.store.rows.audit.find((event) => event.kind === "account.reauthorized")
    expect(audit?.detail).toMatchObject({ loginStartedStatus: "active", status: expected })
    expect(JSON.stringify(audit)).not.toContain("synthetic-code")
  })
}

for (const intent of ["disable", "recheck", "credential", "delete"] as const) {
  test(`CLI completion cannot cross a newer operator ${intent}`, async () => {
    const h = await completeAfter(async (store, id) => {
      if (intent === "delete") {
        await store.accounts.delete(id)
      } else if (intent === "recheck") {
        await store.accounts.recheckAccount({ id, now: NOW })
      } else {
        await store.accounts.updateOperatorAccount({
          id,
          patch:
            intent === "disable"
              ? { status: "disabled" }
              : { authMaterial: "synthetic-ciphertext" },
          now: NOW,
        })
      }
    })
    expect(h.result.ok).toBe(false)
    if (h.result.ok) throw new Error("unexpected confirmation")
    expect(h.result.failure.code).toBe("authorization_superseded")
    expect(h.events).toEqual([])
    expect(h.row?.authRecoveryVersion ?? 0).toBe(intent === "credential" ? 1 : 0)
    if (intent !== "delete") expect(h.row?.lifecycleVersion).toBe(1)
    if (intent === "disable") expect(h.row?.status).toBe("disabled")
    if (intent === "credential") expect(h.row?.authMaterial).toBe("synthetic-ciphertext")
    if (intent === "delete") expect(h.row).toBeUndefined()
  })
}
