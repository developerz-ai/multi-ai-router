import { expect, test } from "bun:test"
import { createClaudeConnectService } from "../../../src/services/accounts/connect/claude"
import { createAccountsService } from "../../../src/services/accounts/service"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore } from "../../support/memory-store"

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}

test("deletion cancels a login before its URL and preserves the directory until confirmed owner exit", async () => {
  const store = createMemoryStore(),
    config = createMemoryConfigDirs()
  const id = crypto.randomUUID()
  const row = await store.accounts.create(
    { id, provider: "anthropic-oauth", label: "fixture", configDir: config.dirs.pathFor(id) },
    new Date(),
  )
  await config.dirs.provision(id)
  const entered = deferred(),
    url = deferred(),
    exited = deferred()
  let cancelCalls = 0
  let abortObserved = false
  let ownerAlive = true
  const connect = createClaudeConnectService({
    accounts: store.accounts,
    configDirs: config.dirs,
    credentials: { settle: async () => "compact" },
    pendingLoginMinutes: 1,
    shutdownDrainMs: 5,
    now: () => new Date(),
    audit: { record: async () => {} },
    login: {
      start: async ({ signal }) => {
        signal?.addEventListener("abort", () => {
          abortObserved = true
        })
        entered.release()
        await url.promise
        return {
          authorizeUrl: "https://fixture.invalid/?state=fixture",
          state: "fixture",
          submit: async () => {},
          exited: exited.promise,
          cancelAsync: async () => {
            await exited.promise
          },
          cancel: () => {
            cancelCalls++
          },
        }
      },
    },
  })
  const events: string[] = []
  const service = createAccountsService({
    accounts: store.accounts,
    keys: store.keys,
    cipher: { encrypt: (value) => value },
    configDirs: config.dirs,
    revokeDeletedAccount: async () => {
      events.push("tombstone")
      connect.revoke(id)
    },
    deletionCommitted: async () => {
      expect(await store.accounts.findById(id)).toBeUndefined()
      events.push("barrier")
    },
    cleanupDeletedAccount: async () => {
      events.push("cleanup")
      if (ownerAlive) return "deferred"
      await config.dirs.remove(id)
      return "removed"
    },
    audit: {
      record: async () => {
        throw new Error("audit unavailable")
      },
    },
    now: () => new Date(),
  })
  const begun = connect.begin(id, "connect")
  await entered.promise
  await expect(service.remove(id)).rejects.toThrow("audit unavailable")
  expect(events).toEqual(["tombstone", "barrier", "cleanup"])
  expect(abortObserved).toBe(true)
  expect(config.present.has(row.configDir ?? "")).toBe(true)
  url.release()
  const result = await begun
  expect(result.ok).toBe(false)
  expect(cancelCalls).toBeGreaterThan(0)
  const stopped = connect.stop()
  await stopped
  expect(ownerAlive).toBe(true)
  ownerAlive = false
  exited.release()
  await config.dirs.remove(id)
  expect(config.present.has(row.configDir ?? "")).toBe(false)
})

test("stored config path mismatch refuses before provisioning or login launch", async () => {
  const store = createMemoryStore(),
    config = createMemoryConfigDirs()
  const row = await store.accounts.create(
    { provider: "anthropic-oauth", label: "fixture", configDir: "/other-root/account" },
    new Date(),
  )
  let starts = 0
  const connect = createClaudeConnectService({
    accounts: store.accounts,
    configDirs: config.dirs,
    credentials: { settle: async () => "compact" },
    pendingLoginMinutes: 1,
    now: () => new Date(),
    audit: { record: async () => {} },
    login: {
      start: async () => {
        starts++
        throw new Error("must not start")
      },
    },
  })
  const result = await connect.begin(row.id, "connect")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.failure.code).toBe("config_dir_mismatch")
  expect(starts).toBe(0)
  expect(config.calls).toHaveLength(0)
  await connect.stop()
})

test("metadata settle returning after the shutdown deadline cannot begin a late authorization CAS", async () => {
  const store = createMemoryStore(),
    config = createMemoryConfigDirs()
  const id = crypto.randomUUID()
  await store.accounts.create(
    { id, provider: "anthropic-oauth", label: "fixture", configDir: config.dirs.pathFor(id) },
    new Date(),
  )
  const entered = deferred(),
    settle = deferred()
  let audits = 0
  const connect = createClaudeConnectService({
    accounts: store.accounts,
    configDirs: config.dirs,
    pendingLoginMinutes: 1,
    shutdownDrainMs: 5,
    now: () => new Date(),
    audit: {
      record: async () => {
        audits++
      },
    },
    login: {
      start: async () => ({
        authorizeUrl: "https://fixture.invalid",
        state: "fixture",
        submit: async () => {},
        exited: Promise.resolve(),
        cancel: () => {},
        cancelAsync: async () => {},
      }),
    },
    credentials: {
      settle: async () => {
        entered.release()
        await settle.promise
        return "compact"
      },
    },
  })
  expect((await connect.begin(id, "connect")).ok).toBe(true)
  const completion = connect.complete(id, "code#fixture")
  await entered.promise
  await connect.stop()
  settle.release()
  const result = await completion
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.failure.code).toBe("authorization_superseded")
  expect((await store.accounts.findById(id))?.lifecycleVersion).toBe(0)
  expect(audits).toBe(0)
})
