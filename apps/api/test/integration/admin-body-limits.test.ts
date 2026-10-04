import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { createApp } from "../../src/app"
import { errorHandler } from "../../src/middleware/errorHandler"
import { adminKeyRoutes } from "../../src/routes/admin/keys"
import { createAuditRecorder } from "../../src/services/admin/audit"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { createKeysService } from "../../src/services/keys/service"
import type { AppEnv } from "../../src/types"
import { createMemoryStore } from "../support/memory-store"

import {
  adminFixture,
  authService,
  headerCases,
  logger,
  login,
  probes,
  request,
} from "./admin-body-fixtures"

describe("actual Hono bounded admin preparation", () => {
  test("anonymous login oversized known/unknown length is413 before credentialcatch", async () => {
    for (const headers of headerCases) {
      const fixture = login()
      const response = await fixture.app.fetch(
        request(JSON.stringify({ password: "x".repeat(100) }), headers),
      )
      expect(response.status).toBe(413)
      expect(JSON.stringify(await response.json())).toContain("request_too_large")
      expect(fixture.calls()).toBe(0)
    }
  })
  test("actual app mount forwards configurable anonymous login ceiling", async () => {
    let calls = 0
    const app = createApp({
      logger,
      probes,
      adminBodies: { maximumJsonBytes: 64, maximumLoginJsonBytes: 16 },
      admin: adminFixture({
        ...authService(),
        completeLocalLogin: async () => {
          calls++
          throw new Error("fixture credential")
        },
      }),
    })
    const response = await app.fetch(request('{"password":"too-long"}'))
    expect(response.status).toBe(413)
    expect(calls).toBe(0)
  })
  test("malformed login stays400; admitted credential failure remains401", async () => {
    const fixture = login()
    expect((await fixture.app.fetch(request("bad JSON"))).status).toBe(400)
    expect((await fixture.app.fetch(request('{"password":"wrong"}'))).status).toBe(401)
    expect(fixture.calls()).toBe(1)
    const failed = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("fixture body transport failure"))
      },
    })
    expect((await fixture.app.fetch(request(failed))).status).toBe(400)
    expect(fixture.calls()).toBe(1)
  })
  test("guard rejects before pull; authorized CRUD oversized cannot mutate", async () => {
    let calls = 0,
      pulled = 0
    const store = createMemoryStore(),
      cipher = createCredentialCipher({ key: new Uint8Array(32).fill(7) })
    const keys = createKeysService({
      keys: store.keys,
      mutations: store.mutations,
      onCommitted: () => {},
      cipher,
      audit: createAuditRecorder(store.audit),
      now: () => new Date(),
    })
    const app = new Hono<AppEnv>().onError(errorHandler(logger))
    app.route(
      "/api/admin/keys",
      adminKeyRoutes({
        maximumJsonBytes: 16,
        guard: async (c, next) => {
          if (c.req.header("authorization") !== "fixture")
            return c.json({ error: "unauthorized" }, 401)
          await next()
        },
        service: {
          ...keys,
          create: async (input) => {
            calls++
            return keys.create(input)
          },
        },
      }),
    )
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          pulled++
        },
      },
      { highWaterMark: 0 },
    )
    const refused = await app.fetch(
      new Request("http://fixture/api/admin/keys", {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit),
    )
    expect(refused.status).toBe(401)
    expect(pulled).toBe(0)
    const oversized = await app.fetch(
      new Request("http://fixture/api/admin/keys", {
        method: "POST",
        headers: { authorization: "fixture" },
        body: JSON.stringify({ name: "x".repeat(100) }),
      }),
    )
    expect(oversized.status).toBe(413)
    expect(calls).toBe(0)
    expect(
      (
        await app.fetch(
          new Request("http://fixture/api/admin/keys", {
            method: "POST",
            headers: { authorization: "fixture" },
            body: '{"name":"a"}',
          }),
        )
      ).status,
    ).toBe(201)
    expect(calls).toBe(1)
  })
})
