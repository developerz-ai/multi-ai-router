import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AppDeps, createApp } from "../../src/app"
import { createLogger } from "../../src/logging/logger"
import {
  createAccountsService,
  createClaudeConnectService,
  createConnectService,
  createOAuthConnectService,
  createRecheckService,
} from "../../src/services/accounts"
import { createAuditRecorder } from "../../src/services/admin"
import { createAdminAuthService } from "../../src/services/admin-auth/service"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import {
  createDispatcher,
  createHealthStore,
  createRouterKeyVerifier,
} from "../../src/services/dataplane"
import { createKeysService } from "../../src/services/keys"
import { createPoolsService } from "../../src/services/pools"
import { createSettingsService } from "../../src/services/settings"
import { createUsageService } from "../../src/services/usage-read"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { createMemoryStore } from "../support/memory-store"
import {
  account,
  cipher as accountCipher,
  apiKeyRow,
  catalog,
  keyRepository,
  newRouterKey,
} from "../unit/dataplane/fixtures"
import {
  INTERVALS,
  memoryAuditLog,
  memoryPrices,
  memoryTasks,
  RETENTION,
} from "../unit/settings/fixtures"

/**
 * The image ships `dist/web/` and the router serves it: `GET /` is the console, not a JSON 404.
 *
 * A real directory on disk, because the thing under test is a static file server — a fake
 * filesystem would only assert that the stub was called. Nothing else here touches I/O: no
 * database, no upstream, and the readiness probes are injected.
 */

const INDEX_HTML = "<!doctype html><html><head><title>multi-ai-router</title></head></html>"
const BUNDLE_JS = 'export const version = "test"\n'
const ASSET_PATH = "/assets/index-abc123.js"

/** Stands in for anything on the host that is not the console — `ENCRYPTION_KEY`, a token file. */
const SECRET = "ENCRYPTION_KEY=must-never-be-served\n"

let root: string
/** A sibling of the web root, so escaping the root by one segment is enough to reach it. */
let secretDir: string
let secretPath: string

function harness(options: { readonly webRoot?: string } = {}) {
  const deps: AppDeps = {
    logger: createLogger({ level: "debug", write: () => {} }),
    probes: {
      database: () => Promise.resolve(true),
      accounts: () => Promise.resolve("ok"),
      claudeCli: () => Promise.resolve("platform_package"),
    },
    webRoot: "webRoot" in options ? options.webRoot : root,
  }
  return createApp(deps)
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "router-web-"))
  mkdirSync(join(root, "assets"))
  writeFileSync(join(root, "index.html"), INDEX_HTML)
  writeFileSync(join(root, ASSET_PATH.slice(1)), BUNDLE_JS)

  secretDir = mkdtempSync(join(tmpdir(), "router-secret-"))
  secretPath = join(secretDir, "env")
  writeFileSync(secretPath, SECRET)
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(secretDir, { recursive: true, force: true })
})

describe("the built console", () => {
  test("answers GET / with the shell rather than a JSON 404", async () => {
    const res = await harness().request("/")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("serves a hashed asset from disk with its own type", async () => {
    const res = await harness().request(ASSET_PATH)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("javascript")
    expect(await res.text()).toBe(BUNDLE_JS)
  })

  test("caches hashed assets forever and never the shell — a stale index is a white screen", async () => {
    const app = harness()

    expect((await app.request(ASSET_PATH)).headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    )
    expect((await app.request("/")).headers.get("Cache-Control")).toBe("no-cache")
  })

  test("is absent entirely when no webRoot is configured", async () => {
    const res = await harness({ webRoot: undefined }).request("/")

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { type: "invalid_request_error" } })
  })
})

describe("history-API fallback", () => {
  test("returns the shell for a client route that is not a file", async () => {
    const res = await harness().request("/accounts")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("returns the shell for a nested client route — a reload on a deep link must work", async () => {
    const res = await harness().request("/usage/by-key/key-1")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("does not answer a non-document method — a wrong-method API call still gets JSON", async () => {
    const res = await harness().request("/accounts", { method: "POST" })

    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("application/json")
  })
})

/**
 * The fallback answers *every* unclaimed document path, so it is the one handler an unauthenticated
 * caller can aim anything at. Two ways that goes wrong, and both are asserted below rather than
 * assumed from the middleware's documentation:
 *
 * - It reads a file outside the web root, which on this host is a credential.
 * - It is handed a path the filesystem cannot name and *throws*, which reaches the client as a
 *   `500` with a stack in the error log — a log flood and a fingerprinting oracle, one URL at a
 *   time. A path that cannot name a file names no document either: the shell is the honest answer.
 */
describe("a path that could never be a client route", () => {
  /** Every spelling of "leave the web root" a proxy or a browser might not normalise away. */
  function traversals(): readonly string[] {
    const secretBase = secretDir.split("/").filter(Boolean).slice(-1)[0] ?? ""
    return [
      "/../../etc/passwd",
      "/%2e%2e/%2e%2e/etc/passwd",
      "/..%2f..%2fetc%2fpasswd",
      "/%2e%2e%2f%2e%2e%2fetc%2fpasswd",
      "/%252e%252e%252f%252e%252e%252fetc%252fpasswd",
      "/..\\..\\etc\\passwd",
      "/%5c..%5c..%5cetc%5cpasswd",
      "/....//....//etc/passwd",
      "/assets/%2e%2e/%2e%2e/etc/passwd",
      // Aimed at the real file this test wrote, one directory up from the root.
      `/../${secretBase}/env`,
      `/%2e%2e%2f${secretBase}%2fenv`,
      `/assets/..%2f..%2f${secretBase}%2fenv`,
      // Absolute, on the chance the join treats it as one and discards the root.
      `${secretPath}`,
    ]
  }

  test("hands out the shell, never a file outside the root, for every traversal spelling", async () => {
    const app = harness()

    for (const path of traversals()) {
      const res = await app.request(path)
      const body = await res.text()

      expect(body).not.toContain(SECRET)
      expect({ path, status: res.status, body }).toEqual({ path, status: 200, body: INDEX_HTML })
    }
  })

  test("answers the shell for a path the filesystem cannot name, never a 500", async () => {
    const app = harness()
    const unnameable = [
      // A NUL byte: `Bun.file` rejects the argument outright rather than reporting a miss.
      "/%00",
      "/config%00",
      // NUL truncation — a server that passed this through would open `index.html` and mislabel it.
      "/index.html%00.js",
      "/assets/%00.js",
      // Past PATH_MAX: the open fails with ENAMETOOLONG before any lookup happens.
      `/${"a".repeat(5_000)}`,
      `/assets/${"b".repeat(5_000)}.js`,
    ]

    for (const path of unnameable) {
      const res = await app.request(path)
      const body = await res.text()

      expect({ path, status: res.status, body }).toEqual({ path, status: 200, body: INDEX_HTML })
    }
  })

  test("keeps a malformed API path on the API's error shape, not the shell", async () => {
    const app = harness()

    for (const path of ["/api/admin/%00", "/v1/messages%00", `/v1/${"a".repeat(5_000)}`]) {
      const res = await app.request(path)

      expect({ path, status: res.status }).toEqual({ path, status: 404 })
      expect(res.headers.get("Content-Type")).toContain("application/json")
    }
  })
})

describe("the API is never shadowed", () => {
  test("leaves the health endpoints alone", async () => {
    const app = harness()

    expect(await (await app.request("/healthz")).json()).toMatchObject({ status: "ok" })
    expect((await app.request("/readyz")).status).toBe(200)
  })

  test("an unknown admin path is a JSON 404, not a page of HTML", async () => {
    const res = await harness().request("/api/admin/nope")

    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } })
  })

  test("an unknown data-plane path answers in its own dialect, not with the shell", async () => {
    const res = await harness().request("/v1/messages/nope")

    expect(res.status).toBe(404)
    expect(await res.json()).toMatchObject({ error: { code: "not_found" } })
  })

  test("/metrics stays a 404 when it is not mounted — never the console", async () => {
    const res = await harness().request("/metrics")

    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("application/json")
  })
})

/**
 * The suites above mount the SPA alone, which proves the *fallback* never answers for a claimed
 * prefix — but every check above sees an unauthenticated admin/data-plane request land as a 404,
 * because nothing above actually mounts those planes. That leaves the one gap this PR exists to close
 * unproven: a real deployment runs all three planes in the same process (`main.ts`), and the
 * failure mode "the SPA fallback swallows a real, mounted, but unauthenticated API request and
 * hands back HTML" only shows up once the admin and data-plane routers are the genuine article —
 * real guards, real `routerKeyAuth` — sitting next to the static mount, not a stand-in.
 *
 * So this builds the whole `createApp` graph once: real admin services over in-memory
 * repositories (the house pattern, `test/support/memory-store.ts`), a real data-plane dispatcher
 * with a stubbed upstream, and the same webRoot fixture the suites above use. No cookie, no router
 * key — the unauthenticated case is the only one this file needs.
 */
describe("the full app, mounted end to end", () => {
  function fullApp() {
    const now = () => new Date("2026-07-25T12:00:00.000Z")

    const routingCipher = accountCipher()
    const routableAccounts = [account("acct-1", { apiKey: "sk-one", cipher: routingCipher })]
    const routingCatalog = catalog(routableAccounts, [])
    const health = createHealthStore()
    const verifier = createRouterKeyVerifier({
      repository: keyRepository([apiKeyRow(newRouterKey(), routingCipher, { scope: "all" })]),
      cipher: routingCipher,
      loadScope: async () => ({ kind: "all" }),
      now,
    })
    const dispatcher = createDispatcher({
      catalog: routingCatalog,
      health,
      cipher: routingCipher,
      usage: { record: () => {} },
      // Never reached: an unauthenticated request is rejected by `routerKeyAuth` first.
      fetch: () => Promise.reject(new Error("no upstream in this harness")),
      clock: { now, monotonic: () => 0 },
      onRequest: () => {},
      options: { failover: { maxAttempts: 3 } },
    })

    const store = createMemoryStore()
    const adminCipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
    const audit = createAuditRecorder(store.audit)
    const configDirs = createMemoryConfigDirs()
    // Never reached: every admin route below is hit with no session cookie, so the guard rejects
    // before a single service method runs.
    const unreached = () => Promise.reject(new Error("not exercised by an unauthenticated request"))

    const deps: AppDeps = {
      logger: createLogger({ level: "error", write: () => {} }),
      probes: {
        database: () => Promise.resolve(true),
        accounts: () => Promise.resolve("ok"),
        claudeCli: () => Promise.resolve("platform_package"),
      },
      webRoot: root,
      dataPlane: { verifier, dispatcher, catalog: routingCatalog, health },
      admin: {
        auth: createAdminAuthService({
          env: {
            adminUsername: "admin",
            adminCredential: { kind: "hash", value: "$argon2id$unused$" },
            encryptionKey: Buffer.alloc(32, 7).toString("base64"),
          },
          config: {},
          now: () => now().getTime(),
        }),
        accounts: createAccountsService({
          accounts: store.accounts,
          keys: store.keys,
          cipher: adminCipher,
          configDirs: configDirs.dirs,
          audit,
          now,
        }),
        pools: createPoolsService({
          pools: store.pools,
          accounts: store.accounts,
          keys: store.keys,
          audit,
          now,
        }),
        keys: createKeysService({
          keys: store.keys,
          pools: store.pools,
          accounts: store.accounts,
          cipher: adminCipher,
          audit,
          now,
        }),
        usage: createUsageService({
          usage: {
            totals: unreached,
            latency: unreached,
            series: unreached,
            seriesByDimension: unreached,
            breakdown: unreached,
          },
          recent: { recent: unreached },
          daily: { totals: unreached, breakdown: unreached },
          scheduledTasks: memoryTasks(),
          labels: async () => ({ keys: [], accounts: [], pools: [], models: [] }),
          now,
        }),
        settings: createSettingsService({
          prices: memoryPrices(),
          scheduledTasks: memoryTasks(),
          auditEvents: memoryAuditLog([]),
          audit,
          env: { retention: RETENTION, logLevel: "warn", janitorIntervalMinutes: 42 },
          intervals: INTERVALS,
          now,
        }),
        recheck: createRecheckService({
          accounts: store.accounts,
          health: createHealthStore(),
          audit,
          cooldownSeconds: 60,
          now,
        }),
        connect: createConnectService({
          accounts: store.accounts,
          claude: createClaudeConnectService({
            accounts: store.accounts,
            configDirs: configDirs.dirs,
            login: { start: unreached },
            credentials: { settle: async () => "compact" },
            audit,
            pendingLoginMinutes: 10,
            logger: createLogger({ level: "error", write: () => {} }),
            now,
          }),
          oauth: createOAuthConnectService({
            accounts: store.accounts,
            states: store.oauthStates,
            cipher: adminCipher,
            audit,
            stateMinutes: 10,
            callbackUrl: null,
            fetch: () => Promise.reject(new Error("no upstream in this harness")),
            exchangeTimeoutMs: 1_000,
            now,
          }),
        }),
      },
    }

    return createApp(deps)
  }

  test("GET / is the console shell, admin and data planes mounted alongside it", async () => {
    const res = await fullApp().request("/")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("GET /accounts, a client route, still falls back to the shell", async () => {
    const res = await fullApp().request("/accounts")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("text/html")
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("GET /api/admin/keys with no session is a real 401, not the shell", async () => {
    const res = await fullApp().request("/api/admin/keys")

    expect(res.status).toBe(401)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ error: { code: "admin_auth_failed" } })
  })

  test("POST /v1/messages with no router key is a real 401, not the shell", async () => {
    const res = await fullApp().request("/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(res.status).toBe(401)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ error: { type: "authentication_error" } })
  })

  test("POST /v1/embeddings is mounted too, and answers 401 rather than the shell", async () => {
    // The newest data-plane path, asserted against the real composition root rather than the
    // suite-local harness: a route registered only in the harness would 404 into the SPA fallback
    // here and reach a client as HTML with a 200 on it.
    const res = await fullApp().request("/v1/embeddings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })

    expect(res.status).toBe(401)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ error: { type: "authentication_error" } })
  })

  test("GET /healthz answers JSON alongside a fully mounted app", async () => {
    const res = await fullApp().request("/healthz")

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/json")
    expect(await res.json()).toMatchObject({ status: "ok" })
  })
})
