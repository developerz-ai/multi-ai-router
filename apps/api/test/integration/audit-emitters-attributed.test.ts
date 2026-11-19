import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { Hono } from "hono"
import { adminAuth } from "../../src/middleware/adminAuth"
import { errorHandler } from "../../src/middleware/errorHandler"
import { requestLogger } from "../../src/middleware/logger"
import { requestId } from "../../src/middleware/requestId"
import { ADMIN_ACCOUNTS_BASE_PATH, adminAccountRoutes } from "../../src/routes/admin/accounts"
import { ADMIN_KEYS_BASE_PATH, adminKeyRoutes } from "../../src/routes/admin/keys"
import { ADMIN_POOLS_BASE_PATH, adminPoolRoutes } from "../../src/routes/admin/pools"
import {
  type ConnectService,
  createAccountsService,
  type DiscoverModelsService,
  type RecheckService,
  type TestNowService,
} from "../../src/services/accounts"
import { AUDIT_KINDS, createAuditRecorder } from "../../src/services/admin"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createKeysService } from "../../src/services/keys"
import { createPoolsService } from "../../src/services/pools"
import type { AppEnv } from "../../src/types"
import { accountDeletionFixture } from "../support/account-deletion"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { createMemoryStore } from "../support/memory-store"
import { silentLogger } from "../support/silent-logger"

/**
 * multi-ai-router#453's guard: every place that writes an audit row is reached under a caller.
 *
 * Two legs, because neither alone is enough:
 *
 * 1. **The inventory.** Every `AUDIT_KINDS.<kind>` reference under `src/` is listed below by file
 *    and kind, with the entry point that reaches it. The scan is exact in both directions: a new
 *    emitter fails this test until someone says how it is attributed, and a removed one fails it
 *    until its line goes. An entry point is one of a small set, each with its own proof:
 *    - `guarded`: a route group whose every route sits behind the admin guard (`use("*", guard)`,
 *      asserted below), which runs the handler under the caller (audit-actor-http.test.ts);
 *    - `sign-in`: the unguarded auth routes, recorded as `anonymous` (audit-actor-http.test.ts);
 *    - `task`: a scheduled task, run as `system` saying its name (audit-actor.test.ts);
 *    - `refresher`: the credential refresher's own flights, run as `system`
 *      (refresh-audit-actor.test.ts);
 *    - `recovery`: the router's recovery probe, which spends "Test now" on a permit's timer, run as
 *      `system` / `router-recovery` (audit-actor.test.ts);
 *    - `initiator`: an account connect completed off its start request — the unguarded OAuth
 *      redirect callback, or a device poll by anyone — run as the caller who started it, stored on
 *      its `oauth_states` row (audit-connect-initiator-http.test.ts,
 *      oauth-callback-attributed.test.ts);
 *    - `reader`: names a kind in a query and writes nothing.
 * 2. **The drive.** The guarded emitters a request can reach without an upstream or a subprocess
 *    are driven through their real routes and the real guard here, and every row is checked.
 */

type Entry =
  | { readonly via: "guarded"; readonly group: string; readonly driven?: true }
  | { readonly via: "sign-in" }
  | { readonly via: "task"; readonly task: string }
  | { readonly via: "refresher" }
  | { readonly via: "recovery" }
  | { readonly via: "initiator" }
  | { readonly via: "reader" }

const ACCOUNTS = "routes/admin/accounts.ts"

/** `<file under src/>:<AUDIT_KINDS key>` → how that write is attributed. */
const EMITTERS: Record<string, readonly Entry[]> = {
  "services/accounts/service.ts:accountCreated": [
    { via: "guarded", group: ACCOUNTS, driven: true },
  ],
  "services/accounts/service.ts:accountUpdated": [
    { via: "guarded", group: ACCOUNTS, driven: true },
  ],
  "services/accounts/service.ts:accountDisabled": [
    { via: "guarded", group: ACCOUNTS, driven: true },
  ],
  "services/accounts/service.ts:accountDeleted": [
    { via: "guarded", group: ACCOUNTS, driven: true },
  ],
  "services/accounts/discover-models.ts:accountModelsDiscovered": [
    { via: "guarded", group: ACCOUNTS },
  ],
  "services/accounts/test-now.ts:accountTested": [
    { via: "guarded", group: ACCOUNTS },
    { via: "task", task: "idle_account_probe" },
    { via: "recovery" },
  ],
  "services/accounts/recheck.ts:accountRechecked": [
    { via: "guarded", group: ACCOUNTS },
    { via: "task", task: "cooldown_recheck" },
  ],
  // The credential-metadata decorator parks a blanked login while an operator reads the list.
  "services/accounts/credential.ts:accountUpdated": [{ via: "guarded", group: ACCOUNTS }],
  // Re-check from the console; the idle sweep's auth read; the owner-launch park in two tasks.
  "services/health/claudeAuthProbe.ts:accountReauthorized": [
    { via: "guarded", group: ACCOUNTS },
    { via: "task", task: "idle_account_probe" },
  ],
  "services/health/claudeAuthProbe.ts:accountUpdated": [
    { via: "guarded", group: ACCOUNTS },
    { via: "task", task: "idle_account_probe" },
    { via: "task", task: "credential_keepalive" },
    { via: "task", task: "login_lifetime_watch" },
  ],
  "services/accounts/connect/claude.ts:accountConnected": [{ via: "guarded", group: ACCOUNTS }],
  "services/accounts/connect/claude.ts:accountReauthorized": [{ via: "guarded", group: ACCOUNTS }],
  // Paste capture and the device poll arrive on guarded routes; the redirect on the unguarded
  // callback. Each runs as the connect's starter where its state row names one.
  "services/accounts/connect/oauth-exchange.ts:accountConnected": [
    { via: "guarded", group: ACCOUNTS },
    { via: "initiator" },
  ],
  "services/accounts/connect/oauth-exchange.ts:accountReauthorized": [
    { via: "guarded", group: ACCOUNTS },
    { via: "initiator" },
  ],
  "services/accounts/refresh/status.ts:accountUpdated": [{ via: "refresher" }],
  "services/accounts/refresh/status.ts:accountReauthorized": [{ via: "refresher" }],
  "services/accounts/last-login.ts:accountConnected": [{ via: "reader" }],
  "services/accounts/last-login.ts:accountReauthorized": [{ via: "reader" }],
  "services/keys/mutations.ts:keyCreated": [
    { via: "guarded", group: "routes/admin/keys.ts", driven: true },
  ],
  "services/keys/mutations.ts:keyUpdated": [
    { via: "guarded", group: "routes/admin/keys.ts", driven: true },
  ],
  "services/keys/mutations.ts:keyRevoked": [
    { via: "guarded", group: "routes/admin/keys.ts", driven: true },
  ],
  "services/keys/mutations.ts:keyDeleted": [
    { via: "guarded", group: "routes/admin/keys.ts", driven: true },
  ],
  "services/keys/service.ts:keyRevealed": [
    { via: "guarded", group: "routes/admin/keys.ts", driven: true },
  ],
  "services/pools/mutations.ts:poolCreated": [
    { via: "guarded", group: "routes/admin/pools.ts", driven: true },
  ],
  "services/pools/mutations.ts:poolUpdated": [
    { via: "guarded", group: "routes/admin/pools.ts", driven: true },
  ],
  "services/pools/mutations.ts:policyChanged": [
    { via: "guarded", group: "routes/admin/pools.ts", driven: true },
  ],
  "services/pools/mutations.ts:poolDeleted": [
    { via: "guarded", group: "routes/admin/pools.ts", driven: true },
  ],
  "services/pools/reaper.ts:keyRevoked": [{ via: "task", task: "pool_reap" }],
  "services/pools/reaper.ts:poolDeleted": [{ via: "task", task: "pool_reap" }],
  "services/settings/service.ts:settingsChanged": [
    { via: "guarded", group: "routes/admin/settings.ts" },
  ],
  "services/usage-report/delivery.ts:usageReportDelivered": [
    { via: "guarded", group: "routes/admin/usage.ts" },
  ],
  "services/admin-auth/service.ts:adminLogin": [{ via: "sign-in" }],
  "services/admin-auth/service.ts:adminLoginFailed": [{ via: "sign-in" }],
  "services/admin-auth/service.ts:adminLogout": [{ via: "guarded", group: "routes/admin/auth.ts" }],
}

const SRC = join(import.meta.dir, "../../src")

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return path.endsWith(".ts") ? [path] : []
  })
}

/** Every `AUDIT_KINDS.<key>` reference outside the file that defines them. */
function scannedEmitters(): Set<string> {
  const found = new Set<string>()
  for (const path of sourceFiles(SRC)) {
    const file = relative(SRC, path)
    if (file === "services/admin/audit.ts") continue
    for (const match of readFileSync(path, "utf8").matchAll(/AUDIT_KINDS\.(\w+)/g)) {
      found.add(`${file}:${match[1]}`)
    }
  }
  return found
}

describe("the emitter inventory", () => {
  test("names every AUDIT_KINDS reference under src/, and nothing that is not one", () => {
    const scanned = [...scannedEmitters()].sort()
    // Not vacuous: the scan has to find the emitters it is about.
    expect(scanned.length).toBeGreaterThanOrEqual(30)
    expect(scanned).toEqual(Object.keys(EMITTERS).sort())
  })

  test("every kind the console can filter on has at least one writer", () => {
    const written = new Set(
      Object.entries(EMITTERS)
        .filter(([, entries]) => entries.some((entry) => entry.via !== "reader"))
        .map(([key]) => key.split(":")[1]),
    )
    expect([...written].sort()).toEqual(Object.keys(AUDIT_KINDS).sort())
  })

  test("each guarded group puts the guard in front of every route it serves", () => {
    const groups = new Set(
      Object.values(EMITTERS)
        .flat()
        .flatMap((entry) => (entry.via === "guarded" ? [entry.group] : [])),
    )
    expect(groups.size).toBeGreaterThan(0)
    for (const group of groups) {
      const source = readFileSync(join(SRC, group), "utf8")
      if (group === "routes/admin/auth.ts") {
        // The one group that is not guarded wholesale: `/logout` names the guard on its own route.
        expect(source).toMatch(/routes\.post\("\/logout", guard,/)
        continue
      }
      // Registered before any route, so every handler in the group runs inside the guard.
      const guardAt = source.indexOf('routes.use("*", deps.guard)')
      const firstRoute = source.search(/routes\.(get|post|patch|put|delete)\(/)
      expect({ group, guarded: guardAt >= 0 && guardAt < firstRoute }).toEqual({
        group,
        guarded: true,
      })
    }
  })

  test("every task an entry names is a registered scheduled task", () => {
    const registered = new Set(
      sourceFiles(join(SRC, "scheduler/tasks")).flatMap((path) =>
        [...readFileSync(path, "utf8").matchAll(/\bname: "(\w+)"/g)].map((match) => match[1]),
      ),
    )
    const named = Object.values(EMITTERS)
      .flat()
      .flatMap((entry) => (entry.via === "task" ? [entry.task] : []))
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter((task) => !registered.has(task))).toEqual([])
  })
})

const TOKEN = "g".repeat(48)
const NOW = new Date("2026-11-19T12:00:00.000Z")

function unreachable(name: string): never {
  throw new Error(`${name} is not driven by this test`)
}

function harness() {
  const store = createMemoryStore()
  const lines: Record<string, unknown>[] = []
  const logger = silentLogger()
  const audit = createAuditRecorder(store.audit, logger)
  const cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
  const configDirs = createMemoryConfigDirs()
  const guard = adminAuth(
    { authenticate: async () => unreachable("session auth"), assertCsrf: () => {} },
    false,
    TOKEN,
    0,
  )
  const app = new Hono<AppEnv>()
  app.use("*", requestId())
  app.use("*", requestLogger(logger))
  app.onError(errorHandler(logger, null))
  app.route(
    ADMIN_ACCOUNTS_BASE_PATH,
    adminAccountRoutes({
      guard,
      service: createAccountsService({
        accounts: store.accounts,
        keys: store.keys,
        pools: store.pools,
        cipher,
        configDirs: configDirs.dirs,
        ...accountDeletionFixture(configDirs.dirs),
        audit,
        now: () => NOW,
      }),
      recheck: {} as RecheckService,
      testNow: {} as TestNowService,
      discoverModels: {} as DiscoverModelsService,
      connect: {} as ConnectService,
    }),
  )
  app.route(
    ADMIN_POOLS_BASE_PATH,
    adminPoolRoutes({
      guard,
      service: createPoolsService({
        logger,
        mutations: store.mutations,
        onCommitted: () => {},
        pools: store.pools,
        accounts: store.accounts,
        now: () => NOW,
      }),
    }),
  )
  app.route(
    ADMIN_KEYS_BASE_PATH,
    adminKeyRoutes({
      guard,
      service: createKeysService({
        logger,
        mutations: store.mutations,
        onCommitted: () => {},
        keys: store.keys,
        cipher,
        audit,
        now: () => NOW,
      }),
    }),
  )
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "x-admin-actor": "emitter-guard",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    // The body rides along so a refusal names its reason in the failure diff.
    expect({ method, path, ok: response.ok, text }).toEqual({ method, path, ok: true, text })
    return (text === "" ? {} : JSON.parse(text)) as { id: string }
  }
  return { store, call, lines }
}

describe("the guarded emitters, driven through their routes", () => {
  test("every row they write names the caller", async () => {
    const { store, call } = harness()

    const account = await call("POST", ADMIN_ACCOUNTS_BASE_PATH, {
      label: "emitter-guard",
      provider: "openrouter",
      credential: "sk-or-emitter-guard-credential",
    })
    await call("PATCH", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`, { label: "renamed" })

    const pool = await call("POST", ADMIN_POOLS_BASE_PATH, {
      name: "emitter-guard",
      members: [{ accountId: account.id }],
    })
    await call("PATCH", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`, { name: "renamed" })
    await call("PATCH", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`, { policy: "round-robin" })

    const key = await call("POST", ADMIN_KEYS_BASE_PATH, { name: "emitter-guard" })
    await call("PATCH", `${ADMIN_KEYS_BASE_PATH}/${key.id}`, { name: "renamed" })
    await call("POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/reveal`)
    await call("POST", `${ADMIN_KEYS_BASE_PATH}/${key.id}/revoke`)
    await call("DELETE", `${ADMIN_KEYS_BASE_PATH}/${key.id}`)

    await call("DELETE", `${ADMIN_POOLS_BASE_PATH}/${pool.id}`)
    await call("POST", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}/disable`)
    await call("DELETE", `${ADMIN_ACCOUNTS_BASE_PATH}/${account.id}`)

    const driven = Object.entries(EMITTERS)
      .filter(([, entries]) => entries.some((entry) => entry.via === "guarded" && entry.driven))
      .map(([key]) => AUDIT_KINDS[key.split(":")[1] as keyof typeof AUDIT_KINDS])
    const seen = new Set(store.rows.audit.map((row) => row.kind))
    // Every emitter marked `driven` actually wrote here — the guard cannot pass on a quiet run.
    expect([...new Set(driven)].filter((kind) => !seen.has(kind))).toEqual([])
    for (const row of store.rows.audit) {
      expect({ kind: row.kind, actorKind: row.actorKind, actorSays: row.actorSays }).toEqual({
        kind: row.kind,
        actorKind: "api_token",
        actorSays: "emitter-guard",
      })
    }
  })
})
