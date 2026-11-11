import { describe, expect, test } from "bun:test"
import type { Logger } from "../../../src/logging/logger"
import { createFastCredentialCache } from "../../../src/providers/claude-fast/credential-cache"
import { FastTransportError } from "../../../src/providers/claude-fast/failure"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../../src/providers/claude-sdk/concurrency"
import { classifySdkFailure } from "../../../src/providers/claude-sdk/errors"
import type { SdkInvocation } from "../../../src/providers/claude-sdk/invoke"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"

/**
 * 101 findings 05.7 (fast failures carry a class and a logged, redacted reason; preparation
 * failures fall back to the SDK), 05.12 (a permanent fallback is warned once per Account and
 * reason) and 05.2 (warm requests read the credential once; a rewrite, a 401 or a revoke re-read).
 */

const TOKEN = "selected-account-secret"
const credential = {
  accessToken: TOKEN,
  expiresAt: Date.now() + 3_600_000,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}
const event = (value: object) => `data: ${JSON.stringify(value)}\n\n`
const wire = [
  event({
    type: "message_start",
    message: { id: "m", type: "message", role: "assistant", model: "claude-opus-5", content: [] },
  }),
  event({ type: "message_stop" }),
].join("")

function input(body: Record<string, unknown> = {}): SdkInvocation {
  return {
    accountId: "account",
    configDir: "/isolated/account",
    apiKeyId: "key",
    sessionKey: "session",
    model: "claude-opus-5",
    body: Buffer.from(
      JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        ...body,
      }),
    ),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
  }
}

function recordingLogger() {
  const warnings: { message: string; fields: Record<string, unknown> }[] = []
  const logger = {
    warn: (message: string, fields: Record<string, unknown> = {}) =>
      warnings.push({ message, fields }),
    info: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Logger
  return { logger, warnings }
}

describe("fast transport failures carry a class and a reason (05.7)", () => {
  test("a reset connection throws FastTransportError, logged by code, classified retryable", async () => {
    const { logger, warnings } = recordingLogger()
    const reset = Object.assign(new Error(`socket hang up near ${TOKEN}`), { code: "ECONNRESET" })
    const invoke = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      errorMaxBytes: 4096,
      credential: async () => credential,
      resolveModel: (_, model) => model,
      sdk: async () => new Response("sdk"),
      fetch: async () => {
        throw reset
      },
      logger,
    })
    const error = await invoke(input()).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(FastTransportError)
    expect((error as FastTransportError).cause).toBe(reset)
    expect((error as Error).message).toBe("Claude direct HTTP request failed")
    expect(classifySdkFailure(error).classification.retryable).toBe(true)
    expect(warnings).toEqual([
      {
        message: "Claude direct HTTP request failed",
        fields: { component: "claude-fast", accountId: "account", reason: "ECONNRESET" },
      },
    ])
    expect(JSON.stringify(warnings)).not.toContain(TOKEN)
  })

  test("a preparation failure falls back to the SDK once, with no HTTP and one warn", async () => {
    const { logger, warnings } = recordingLogger()
    let fetched = 0
    let sdk = 0
    const fallbacks: string[] = []
    const invoke = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      errorMaxBytes: 4096,
      credential: async () => credential,
      resolveModel: (_, model) => model,
      sdk: async () => {
        sdk++
        return new Response("sdk")
      },
      fetch: async () => {
        fetched++
        return new Response(wire, { headers: { "content-type": "text/event-stream" } })
      },
      onFallback: (reason, accountId) => fallbacks.push(`${reason}:${accountId}`),
      logger,
    })
    // A system block whose billing header names another CLI build cannot be stamped: "profile".
    const foreign = {
      system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=9.9.9.abc;" }],
    }
    expect(await (await invoke(input(foreign))).text()).toBe("sdk")
    expect(fetched).toBe(0)
    expect(sdk).toBe(1)
    expect(fallbacks).toEqual(["profile:account"])
    expect(warnings.map((w) => w.message)).toContain(
      "Claude fast mode falls back to the SDK for this account",
    )
  })
})

describe("a permanent fallback is visible (05.12)", () => {
  test("two fallbacks for one account: one warn, two counts", async () => {
    const { logger, warnings } = recordingLogger()
    const fallbacks: string[] = []
    const invoke = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      errorMaxBytes: 4096,
      credential: async () => null,
      resolveModel: (_, model) => model,
      sdk: async () => new Response("sdk"),
      onFallback: (reason, accountId) => fallbacks.push(`${reason}:${accountId}`),
      logger,
    })
    await invoke(input())
    await invoke(input())
    expect(fallbacks).toEqual(["credential:account", "credential:account"])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.fields).toMatchObject({ accountId: "account", reason: "credential" })
  })
})

describe("the fast credential is read under the fence only when it changed (05.2)", () => {
  function cache(options: { revoked?: () => boolean } = {}) {
    let reads = 0
    let stamp = "1:100:5"
    const revoked = options.revoked ?? (() => false)
    const c = createFastCredentialCache({
      read: async () => {
        reads++
        return credential
      },
      stamp: async () => stamp,
      admitted: () => !revoked(),
    })
    return {
      cache: c,
      reads: () => reads,
      rewrite: () => {
        stamp = "1:100:6"
      },
    }
  }

  test("N warm requests read once", async () => {
    const h = cache()
    for (let i = 0; i < 5; i++) expect(await h.cache.read("a", "/d/a")).toBe(credential)
    expect(h.reads()).toBe(1)
  })

  test("a rewritten credentials file is re-read", async () => {
    const h = cache()
    await h.cache.read("a", "/d/a")
    h.rewrite()
    await h.cache.read("a", "/d/a")
    expect(h.reads()).toBe(2)
  })

  test("a 401 from Anthropic forgets the cached credential", async () => {
    const h = cache()
    const invoke = createFastInvoker({
      concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
      errorMaxBytes: 4096,
      credential: h.cache.read,
      forgetCredential: h.cache.forget,
      resolveModel: (_, model) => model,
      sdk: async () => new Response("sdk"),
      fetch: async () =>
        new Response(JSON.stringify({ type: "error", error: { type: "authentication_error" } }), {
          status: 401,
        }),
    })
    await invoke(input())
    await invoke(input())
    expect(h.reads()).toBe(2)
  })

  test("a revoked account is refused with zero reads", async () => {
    let revoked = false
    const h = cache({ revoked: () => revoked })
    await h.cache.read("a", "/d/a")
    revoked = true
    await expect(h.cache.read("a", "/d/a")).rejects.toBeInstanceOf(UpstreamAdmissionRefused)
    expect(h.reads()).toBe(1)
  })
})
