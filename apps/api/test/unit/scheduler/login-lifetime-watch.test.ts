import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import { createCredentialMetadataReader } from "../../../src/providers/claude-sdk/credential-metadata"
import { createLoginLifetimeWatchTask } from "../../../src/scheduler/tasks/login-lifetime-watch"
import { loginLifetimePolicy } from "../../../src/services/accounts/login-lifetime"
import { accountRow } from "../../support/account-row"

/**
 * The daily login-lifetime warn line: one `warn` per subscription inside the renewal window, with
 * the fields an alert rule matches on — and nothing read from a token.
 */

const NOW = new Date("2026-10-04T12:00:00.000Z")
const DAY = 86_400_000
const ACCESS = "opaque-access-value-watch-41a2"
const REFRESH = "opaque-refresh-value-watch-77c9"

function file(refreshTokenExpiresAt: number | null, tokens = true): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: tokens ? ACCESS : "",
      refreshToken: tokens ? REFRESH : "",
      expiresAt: NOW.getTime() + 3_600_000,
      ...(refreshTokenExpiresAt === null ? {} : { refreshTokenExpiresAt }),
      subscriptionType: "max",
    },
  })
}

function sub(id: string, overrides: Partial<AccountRow> = {}): AccountRow {
  return accountRow({ id, label: `claude ${id}`, provider: "anthropic-oauth", ...overrides })
}

function harness(
  accounts: readonly AccountRow[],
  files: Readonly<Record<string, string>>,
  logins: ReadonlyMap<string, Date> = new Map(),
) {
  const lines: string[] = []
  const reader = createCredentialMetadataReader({
    read: async (path) => {
      const id = Object.keys(files).find((key) => path.includes(`/${key}/`))
      return id === undefined ? null : (files[id] ?? null)
    },
  })
  const asked: string[][] = []
  const task = createLoginLifetimeWatchTask({
    accounts: { list: async () => [...accounts] },
    readMetadata: (account) => reader.read(`/data/claude/${account.id}`),
    lastLogins: async (ids) => {
      asked.push([...ids])
      return logins
    },
    policy: loginLifetimePolicy({ assumedLifetimeDays: 28, renewalWarnDays: 5 }),
    intervalMs: DAY,
  })
  const run = () =>
    task.run({
      now: NOW,
      logger: createLogger({ level: "debug", write: (line) => lines.push(line) }),
      signal: new AbortController().signal,
    })
  const warned = () =>
    lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.msg === "claude subscription login renewal due")
  return { task, run, lines, warned, asked }
}

describe("login_lifetime_watch", () => {
  test("ticks daily under its enum name", () => {
    const { task } = harness([], {})
    expect(task.name).toBe("login_lifetime_watch")
    expect(task.intervalMs).toBe(DAY)
  })

  test("warns once per subscription inside the window, with the alert fields", async () => {
    const h = harness(
      [sub("soon"), sub("later"), sub("estimated")],
      {
        soon: file(NOW.getTime() + 3 * DAY + 3_600_000),
        later: file(NOW.getTime() + 20 * DAY),
        estimated: file(null),
      },
      new Map([["estimated", new Date(NOW.getTime() - 25 * DAY)]]),
    )
    const outcome = await h.run()

    expect(outcome).toEqual({ outcome: "success", itemsProcessed: 2 })
    expect(h.warned()).toEqual([
      expect.objectContaining({
        level: "warn",
        accountId: "soon",
        label: "claude soon",
        renewsAtSource: "reported",
        daysUntilRenewal: 3,
        lastLoginAt: null,
      }),
      expect.objectContaining({
        accountId: "estimated",
        renewsAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
        renewsAtSource: "estimated",
        daysUntilRenewal: 3,
      }),
    ])
  })

  test("parked, disabled, blanked and non-subscription accounts are not warned about", async () => {
    const h = harness(
      [
        sub("parked", { status: "needs_reauth" }),
        sub("off", { status: "disabled" }),
        sub("blank"),
        accountRow({ id: "key", provider: "openai-api" }),
      ],
      {
        parked: file(NOW.getTime() + DAY),
        off: file(NOW.getTime() + DAY),
        blank: file(NOW.getTime() + DAY, false),
      },
    )
    await h.run()
    expect(h.warned()).toEqual([])
    expect(h.asked).toEqual([["blank"]])
  })

  test("an unknown deadline is never a warning", async () => {
    const h = harness([sub("unknown")], { unknown: file(null) })
    await h.run()
    expect(h.warned()).toEqual([])
  })

  test("no token value appears in any line it writes", async () => {
    const h = harness([sub("soon")], { soon: file(NOW.getTime() + DAY) })
    await h.run()
    const all = h.lines.join("\n")
    expect(all).not.toContain(ACCESS)
    expect(all).not.toContain(REFRESH)
  })
})
