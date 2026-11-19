import { afterEach, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownedCredentialMetadataReader } from "../../../src/composition/credential-ownership"
import { createLogger } from "../../../src/logging/logger"
import { createAccountCliOwnership } from "../../../src/providers/claude-sdk/account-ownership"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import { createCredentialTasks } from "../../../src/scheduler/tasks/credential-tasks"
import { IDLE_PROBE_MODELS } from "../../../src/scheduler/tasks/idle-account-probe"
import { createClaudeAuthProbe } from "../../../src/services/health/claudeAuthProbe"
import { createMemoryStore } from "../../support/memory-store"

/**
 * #447 end to end, at the seams the scheduler really runs through: the real ownership manager and
 * the real owned metadata reader over a config root, the real auth probe over a store, and the
 * keepalive and login-lifetime tasks built by the registry's own factory.
 *
 * Prod fingerprint (2.63.0): `credential keepalive: metadata unreadable`, then `uncaught exception
 * — shutting down … posix_spawn '<helper>'`, then a failed `cli-owners` shutdown step. One Account
 * that could not be owned took every other Account down with it.
 */

const NOW = new Date("2026-11-18T12:00:00.000Z")
const MIN = 60_000

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function harness(options: { readonly helperPath?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "router-unownable-"))
  roots.push(root)
  const store = createMemoryStore()
  const subscription = (label: string) =>
    store.accounts.create({ label, provider: "anthropic-oauth", configDir: null })
  const lost = await subscription("lost")
  const healthy = await subscription("healthy")
  const apiKey = await store.accounts.create({ label: "key", provider: "openai-api" })
  // The healthy subscription's directory exists; the lost one's does not survive the volume move.
  await mkdir(join(root, healthy.id), { mode: 0o700 })

  const ownership = createAccountCliOwnership({
    root,
    helperPath: options.helperPath ?? join(root, "no-such-helper"),
    maximumOwners: 2,
    termGraceMs: 30,
    pollMs: 5,
    maximumChildren: 10,
    admissionTimeoutMs: 1000,
    cleanupMaximumEntries: 100,
    cleanupMaximumDepth: 8,
    operationTimeoutMs: 1000,
    shutdownDrainMs: 200,
  })
  const owned = ownedCredentialMetadataReader(
    { read: async () => metadata(2 * MIN) },
    ownership,
    root,
  )
  const audit: Array<{ subjectId?: string | null; detail?: unknown }> = []
  let catalogRefreshes = 0
  const authProbe = createClaudeAuthProbe({
    accounts: store.accounts,
    configDirs: { pathFor: (id) => join(root, id) },
    cli: { check: async () => null },
    audit: {
      record: async (event) => {
        audit.push(event)
      },
    },
    now: () => NOW,
    mutationCommitted: async () => {
      catalogRefreshes += 1
    },
  })
  const tested: string[] = []
  const lines: string[] = []
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })
  const tasks = createCredentialTasks(
    {
      accounts: store.accounts,
      // The healthy Account's read does not go through a guardian here: this suite has no helper
      // on purpose, and what is under test is that the lost Account's failure stays its own.
      credentialMetadata: (account) =>
        account.id === healthy.id
          ? Promise.resolve(metadata(2 * MIN))
          : owned.read(join(root, account.id)),
      lastLogins: async () => new Map(),
      testAccount: async (accountId) => {
        tested.push(accountId)
        return { tested: true, outcome: "ok" }
      },
      authProbe,
      probeModels: IDLE_PROBE_MODELS,
      env: {
        claudeSdkCredentialKeepalive: true,
        claudeLogin: { keepaliveRetryMinutes: 60, lifetimeDays: 30, renewalWarnDays: 3 },
        scheduler: { idleAccountProbeBatchSize: 5 },
      } as never,
    },
    { credential_keepalive: 3 * MIN, login_lifetime_watch: 24 * 60 * MIN },
  )
  const run = async (name: string) => {
    const task = tasks.find((candidate) => candidate.name === name)
    if (task === undefined) throw new Error(`no ${name} task was built`)
    const escaped: unknown[] = []
    const listener = (error: unknown) => escaped.push(error)
    process.on("uncaughtException", listener)
    try {
      const outcome = await task.run({ now: NOW, logger, signal: new AbortController().signal })
      // The runtime reports a failed spawn on a later tick; that is where the crash came from.
      await new Promise((resolve) => setTimeout(resolve, 50))
      return { outcome, escaped }
    } finally {
      process.off("uncaughtException", listener)
    }
  }
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  const status = async (id: string) => (await store.accounts.findById(id))?.status
  return {
    root,
    lost,
    healthy,
    apiKey,
    ownership,
    run,
    tested,
    audit,
    parsed,
    status,
    catalogRefreshes: () => catalogRefreshes,
  }
}

function metadata(expiresInMs: number): CredentialMetadata {
  return {
    hasTokens: true,
    accessTokenExpiresAt: new Date(NOW.getTime() + expiresInMs),
    refreshTokenExpiresAt: null,
  } as CredentialMetadata
}

test("keepalive: an Account with no helper to own it is parked alone; the rest keep serving", async () => {
  const h = await harness()
  const { outcome, escaped } = await h.run("credential_keepalive")

  // The process is still up, and the tick finished as a tick.
  expect(escaped).toEqual([])
  expect(outcome).toEqual({ outcome: "success", itemsProcessed: 1 })
  // The lost Account is out of rotation, by the status routing already skips…
  expect(await h.status(h.lost.id)).toBe("needs_reauth")
  expect(h.catalogRefreshes()).toBe(1)
  // …and every other Account is still routable; the healthy subscription got its turn.
  expect(await h.status(h.healthy.id)).toBe("active")
  expect(await h.status(h.apiKey.id)).toBe("active")
  expect(h.tested).toEqual([h.healthy.id])

  expect(
    h.parsed().find((line) => line.accountId === h.lost.id && line.level === "error"),
  ).toMatchObject({
    msg: "credential owner cannot be launched for this account",
    statusChangedTo: "needs_reauth",
    reason: expect.stringContaining("credential-owner helper is missing or not executable"),
  })
  expect(h.audit).toHaveLength(1)
  expect(h.audit[0]).toMatchObject({
    subjectId: h.lost.id,
    detail: { status: "needs_reauth", previousStatus: "active", source: "credential_owner" },
  })

  // Parked means the next tick does not ask again, and shutdown has no owner left to wait for.
  await h.run("credential_keepalive")
  expect(h.audit).toHaveLength(1)
  await expect(h.ownership.stop()).resolves.toBeUndefined()
})

test("keepalive: a helper that exists and an Account directory that does not parks for a re-login", async () => {
  const h = await harness({ helperPath: process.execPath })
  const { outcome, escaped } = await h.run("credential_keepalive")

  expect(escaped).toEqual([])
  expect(outcome.outcome).toBe("success")
  expect(await h.status(h.lost.id)).toBe("needs_reauth")
  expect(await h.status(h.healthy.id)).toBe("active")
  expect(h.audit[0]).toMatchObject({
    detail: { reason: expect.stringContaining("credential directory is missing") },
  })
})

test("login lifetime watch: the same failure is the same per-account result", async () => {
  const h = await harness()
  const { outcome, escaped } = await h.run("login_lifetime_watch")

  expect(escaped).toEqual([])
  expect(outcome.outcome).toBe("success")
  expect(await h.status(h.lost.id)).toBe("needs_reauth")
  expect(await h.status(h.healthy.id)).toBe("active")
})

test("an operator's disable is never overwritten by a park", async () => {
  const h = await harness()
  const store = createMemoryStore()
  const row = await store.accounts.create({
    label: "off",
    provider: "anthropic-oauth",
    configDir: null,
  })
  const disabled = await store.accounts.disable(row.id, NOW)
  if (disabled === undefined) throw new Error("missing fixture")
  const probe = createClaudeAuthProbe({
    accounts: store.accounts,
    configDirs: { pathFor: (id) => join(h.root, id) },
    cli: { check: async () => null },
    audit: { record: async () => {} },
    now: () => NOW,
  })

  expect(await probe.park(disabled, "credential directory is missing")).toBeNull()
  expect((await store.accounts.findById(row.id))?.status).toBe("disabled")
})
