import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createCredentialMetadataReader } from "../../../src/providers/claude-sdk/credential-metadata"
import { createCredentialKeepaliveTask } from "../../../src/scheduler/tasks/credential-keepalive"
import { IDLE_PROBE_MODELS } from "../../../src/scheduler/tasks/idle-account-probe"
import { accountRow } from "../../support/account-row"

/**
 * The credential keepalive task end to end against doubles: a real metadata reader over an
 * in-memory `.credentials.json`, a "Test now" double that plays the CLI (rewriting the file when it
 * refreshes), and a capturing logger. What it spends turns on, what it says afterwards, and — the
 * security half — that no token value ever reaches a log line.
 *
 * Token values here are deliberately *not* shaped like Anthropic tokens, so the log redactor cannot
 * mask them: a leak would show up verbatim and fail the test, rather than being hidden by a regex.
 */

const NOW = new Date("2026-10-04T12:00:00.000Z")
const MIN = 60_000
const HOUR = 60 * MIN
const LOGIN_DEADLINE = Date.parse("2026-10-30T00:00:00.000Z")
const ACCESS_V1 = "opaque-access-value-one-7f3a"
const REFRESH_V1 = "opaque-refresh-value-one-91bd"
const ACCESS_V2 = "opaque-access-value-two-c0de"
const REFRESH_V2 = "opaque-refresh-value-two-beef"

function credentialFile(access: string, refresh: string, expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: access,
      refreshToken: refresh,
      expiresAt,
      refreshTokenExpiresAt: LOGIN_DEADLINE,
      scopes: ["user:inference"],
      subscriptionType: "max",
    },
  })
}

function sub(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return accountRow({
    id,
    label: id,
    provider: "anthropic-oauth",
    status: "active",
    configDir: `/data/claude/${id}`,
    ...overrides,
  })
}

interface HarnessOptions {
  readonly accounts: readonly AccountRow[]
  /** Access-token expiry per account id, relative to NOW. */
  readonly expiresIn: Readonly<Record<string, number>>
  /** What the CLI does on a turn: refresh (rewrite the file) or not. Default refresh. */
  readonly refreshes?: boolean
  readonly tested?: boolean
  readonly eligible?: boolean
  readonly unreadable?: readonly string[]
}

function harness(options: HarnessOptions) {
  const files = new Map<string, string>()
  for (const [id, ms] of Object.entries(options.expiresIn)) {
    files.set(
      `/data/claude/${id}/.credentials.json`,
      credentialFile(ACCESS_V1, REFRESH_V1, NOW.getTime() + ms),
    )
  }
  const reader = createCredentialMetadataReader({
    read: async (path) => {
      if (options.unreadable?.some((id) => path.includes(id)))
        throw new Error("EACCES: permission denied")
      return files.get(path) ?? null
    },
  })
  const tested: string[] = []
  const lines: string[] = []
  const logger = createLogger({ level: "debug", write: (line) => lines.push(line) })

  const task = createCredentialKeepaliveTask({
    accounts: {
      list: async () => [...options.accounts],
      readEligibleBackgroundAccount: async (id) =>
        options.eligible === false ? undefined : options.accounts.find((a) => a.id === id),
    },
    readMetadata: (account) => reader.read(`/data/claude/${account.id}`),
    test: async (accountId) => {
      tested.push(accountId)
      if (options.tested === false) return { tested: false }
      if (options.refreshes !== false) {
        files.set(
          `/data/claude/${accountId}/.credentials.json`,
          credentialFile(ACCESS_V2, REFRESH_V2, NOW.getTime() + 8 * HOUR),
        )
      }
      return { tested: true, outcome: "ok" }
    },
    models: IDLE_PROBE_MODELS,
    policy: { leadMs: 5 * MIN, retryMs: 60 * MIN, batchSize: 5 },
    intervalMs: 3 * MIN,
  })

  const run = (at: Date = NOW) =>
    task.run({ now: at, logger, signal: new AbortController().signal })
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>)
  return { task, run, tested, lines, parsed }
}

describe("credential_keepalive", () => {
  test("is named for its enum value and ticks on the configured interval", () => {
    const { task } = harness({ accounts: [], expiresIn: {} })
    expect(task.name).toBe("credential_keepalive")
    expect(task.intervalMs).toBe(3 * MIN)
  })

  test("spends a turn only on the subscription the CLI would refresh now", async () => {
    const h = harness({
      accounts: [
        sub("due"),
        sub("fresh"),
        sub("parked", { status: "needs_reauth" }),
        sub("off", { status: "disabled" }),
        accountRow({ id: "key", provider: "openai-api", status: "active" }),
      ],
      expiresIn: { due: 2 * MIN, fresh: 6 * HOUR, parked: -HOUR, off: -HOUR },
    })
    const outcome = await h.run()

    expect(h.tested).toEqual(["due"])
    expect(outcome).toEqual({ outcome: "success", itemsProcessed: 1 })
  })

  test("logs the before/after expiries of a rotation — timestamps only", async () => {
    const h = harness({ accounts: [sub("due")], expiresIn: { due: 2 * MIN } })
    await h.run()

    const line = h
      .parsed()
      .find((entry) => entry.msg === "claude credential refreshed by keepalive")
    expect(line).toMatchObject({
      level: "info",
      accountId: "due",
      refreshed: true,
      accessExpiresAtBefore: new Date(NOW.getTime() + 2 * MIN).toISOString(),
      accessExpiresAtAfter: new Date(NOW.getTime() + 8 * HOUR).toISOString(),
      loginExpiresAtBefore: new Date(LOGIN_DEADLINE).toISOString(),
      loginExpiresAtAfter: new Date(LOGIN_DEADLINE).toISOString(),
      loginExpiryMoved: false,
    })
  })

  test("a turn that did not refresh warns once and is not re-billed every tick", async () => {
    const h = harness({ accounts: [sub("stuck")], expiresIn: { stuck: -MIN }, refreshes: false })
    await h.run()
    await h.run(new Date(NOW.getTime() + 3 * MIN))
    await h.run(new Date(NOW.getTime() + 30 * MIN))

    expect(h.tested).toEqual(["stuck"])
    expect(
      h.parsed().filter((e) => e.msg === "claude keepalive turn did not refresh the access token"),
    ).toHaveLength(1)

    await h.run(new Date(NOW.getTime() + 61 * MIN))
    expect(h.tested).toEqual(["stuck", "stuck"])
  })

  test("a declined turn (cooldown, in flight) is not backed off — nothing ran", async () => {
    const h = harness({ accounts: [sub("busy")], expiresIn: { busy: MIN }, tested: false })
    await h.run()
    await h.run(new Date(NOW.getTime() + 3 * MIN))
    expect(h.tested).toEqual(["busy", "busy"])
  })

  test("an account background admission refuses is never tested", async () => {
    const h = harness({ accounts: [sub("cooling")], expiresIn: { cooling: MIN }, eligible: false })
    await h.run()
    expect(h.tested).toEqual([])
  })

  test("unreadable metadata is unknown: warned, never warmed, never fatal", async () => {
    const h = harness({
      accounts: [sub("locked"), sub("due")],
      expiresIn: { locked: MIN, due: MIN },
      unreadable: ["locked"],
    })
    const outcome = await h.run()
    expect(h.tested).toEqual(["due"])
    expect(outcome.outcome).toBe("success")
    expect(h.parsed().some((e) => e.msg === "credential keepalive: metadata unreadable")).toBe(true)
  })

  test("over the batch, the soonest go first and the run is partial", async () => {
    const accounts = ["a", "b", "c", "d", "e", "f"].map((id) => sub(id))
    const expiresIn = Object.fromEntries(accounts.map((a, i) => [a.id, -i * MIN]))
    const h = harness({ accounts, expiresIn })
    const outcome = await h.run()
    expect([...h.tested].sort()).toEqual(["b", "c", "d", "e", "f"])
    expect(outcome.outcome).toBe("partial")
  })

  test("no token value — before or after the rotation — appears in any log line", async () => {
    const h = harness({
      accounts: [sub("due"), sub("stuck")],
      expiresIn: { due: MIN, stuck: MIN },
    })
    await h.run()
    const all = h.lines.join("\n")
    for (const secret of [ACCESS_V1, REFRESH_V1, ACCESS_V2, REFRESH_V2]) {
      expect(all).not.toContain(secret)
    }
    expect(all).not.toContain('"accessToken"')
    expect(all).not.toContain('"refreshToken"')
  })
})
