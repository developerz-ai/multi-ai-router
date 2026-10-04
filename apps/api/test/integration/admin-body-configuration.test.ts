import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { ADMIN_BODY_ENV_FIELDS, readAdminBodiesEnv } from "../../src/config/admin-bodies"
import { EnvValidationError, parseEnv } from "../../src/config/env"
import { listenOptions } from "../../src/config/listen"

import { baseEnv, login } from "./admin-body-fixtures"

describe("body configuration and actual listener", () => {
  test("defaults and overrides validated as positive safe byte counts", () => {
    expect(readAdminBodiesEnv({}).adminBodies).toEqual({
      maximumJsonBytes: 1024 * 1024,
      maximumLoginJsonBytes: 8192,
    })
    const schema = z.object(ADMIN_BODY_ENV_FIELDS)
    expect(
      readAdminBodiesEnv(
        schema.parse({ ADMIN_JSON_MAX_BYTES: "4096", ADMIN_LOGIN_JSON_MAX_BYTES: "256" }),
      ).adminBodies,
    ).toEqual({ maximumJsonBytes: 4096, maximumLoginJsonBytes: 256 })
    for (const value of ["0", "-1", "1.5", "NaN", "9007199254740992"])
      expect(schema.safeParse({ ADMIN_JSON_MAX_BYTES: value }).success).toBe(false)
  })
  test("actual boot config recognizes admin/login overrides and refuses invalid ceiling", () => {
    const base = {
      DATABASE_URL: "postgres://fixture:fixture@localhost/fixture",
      ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      ADMIN_OIDC_ISSUER_URL: "https://idp.fixture",
      ADMIN_OIDC_CLIENT_ID: "fixture",
      ADMIN_OIDC_REDIRECT_URI: "https://router.fixture/api/admin/auth/oidc/callback",
      ADMIN_OIDC_ADMIN_EMAIL: "admin@fixture",
    }
    expect(
      parseEnv({
        ...base,
        ADMIN_JSON_MAX_BYTES: "2048",
        ADMIN_LOGIN_JSON_MAX_BYTES: "128",
        MAX_REQUEST_BODY_BYTES: "536870912",
      }),
    ).toMatchObject({
      adminBodies: { maximumJsonBytes: 2048, maximumLoginJsonBytes: 128 },
      dataPlane: { maxRequestBodyBytes: 536870912 },
    })
    expect(() => parseEnv({ ...base, ADMIN_LOGIN_JSON_MAX_BYTES: "0" })).toThrow(EnvValidationError)
  })
  test("listener preserves expanded dataplane ceiling above runtime128MiB default", () => {
    const options = listenOptions({
      port: 0,
      serverIdleTimeoutSeconds: 60,
      dataPlane: { ...parseEnv(baseEnv()).dataPlane, maxRequestBodyBytes: 512 * 1024 * 1024 },
      adminBodies: { maximumJsonBytes: 1024, maximumLoginJsonBytes: 128 },
    })
    expect(options.maxRequestBodySize).toBe(512 * 1024 * 1024)
    expect(
      listenOptions({
        port: 0,
        serverIdleTimeoutSeconds: 60,
        dataPlane: { ...parseEnv(baseEnv()).dataPlane, maxRequestBodyBytes: 128 },
        adminBodies: { maximumJsonBytes: 256, maximumLoginJsonBytes: 512 },
      }).maxRequestBodySize,
    ).toBe(512)
  })
  test("actual small listener returns413 for known and chunked admin overflow", async () => {
    const fixture = login()
    const server = Bun.serve({
      ...listenOptions({
        port: 0,
        serverIdleTimeoutSeconds: 60,
        dataPlane: { ...parseEnv(baseEnv()).dataPlane, maxRequestBodyBytes: 256 },
        adminBodies: { maximumJsonBytes: 64, maximumLoginJsonBytes: 32 },
      }),
      hostname: "127.0.0.1",
      fetch: fixture.app.fetch,
    })
    try {
      const url = `http://127.0.0.1:${server.port}/api/admin/auth/login`
      expect(
        (await fetch(url, { method: "POST", body: JSON.stringify({ password: "x".repeat(64) }) }))
          .status,
      ).toBe(413)
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('{"password":"' + "x".repeat(64) + '"}'))
          c.close()
        },
      })
      expect(
        (await fetch(url, { method: "POST", body, duplex: "half" } as RequestInit)).status,
      ).toBe(413)
      expect(fixture.calls()).toBe(0)
    } finally {
      server.stop(true)
    }
  })
  test("actual transport ceiling refuses known and chunked oversize without credentialwork", async () => {
    const fixture = login()
    const server = Bun.serve({
      ...listenOptions({
        port: 0,
        serverIdleTimeoutSeconds: 60,
        dataPlane: { ...parseEnv(baseEnv()).dataPlane, maxRequestBodyBytes: 32 },
        adminBodies: { maximumJsonBytes: 16, maximumLoginJsonBytes: 32 },
      }),
      hostname: "127.0.0.1",
      fetch: fixture.app.fetch,
    })
    try {
      const url = `http://127.0.0.1:${server.port}/api/admin/auth/login`
      const body = JSON.stringify({ password: "x".repeat(128) })
      expect((await fetch(url, { method: "POST", body })).status).toBe(413)
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(body))
          c.close()
        },
      })
      expect(
        (await fetch(url, { method: "POST", body: stream, duplex: "half" } as RequestInit)).status,
      ).toBe(413)
      expect(fixture.calls()).toBe(0)
    } finally {
      server.stop(true)
    }
  })
})
