import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AppDeps, createApp } from "../../src/app"
import { createLogger } from "../../src/logging/logger"

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

let root: string

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
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
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

  test("hands out the shell, never a file, for a traversal attempt", async () => {
    const res = await harness().request("/%2e%2e/%2e%2e/etc/passwd")

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(INDEX_HTML)
  })

  test("does not answer a non-document method — a wrong-method API call still gets JSON", async () => {
    const res = await harness().request("/accounts", { method: "POST" })

    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("application/json")
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
