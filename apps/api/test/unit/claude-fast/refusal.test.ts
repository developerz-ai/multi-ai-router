import { describe, expect, test } from "bun:test"
import { ownedInvoker } from "../../../src/composition/owned-invoker"
import { createFastInvoker } from "../../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../../src/providers/claude-sdk/concurrency"
import type { SdkFailure } from "../../../src/providers/claude-sdk/errors"
import type { SdkInvocation, SdkInvoker } from "../../../src/providers/claude-sdk/invoke"
import { createSdkQuotaStore } from "../../../src/providers/claude-sdk/quota"

/**
 * A fast-transport refusal's classification reaches the caller through every wrapper production
 * composes around the invoker. It once rode a `WeakMap` keyed by the Response, `ownedInvoker` (2.75.0)
 * rebuilt the Response, and 2.70.1's fix was void in production while both halves' tests passed:
 * prod 2026-11-23, 25 of 25 Claude `429` lines carried no signal and each one cooled the Account.
 */

const GATED =
  "Third-party apps now draw from your extra usage, not your plan limits. Add more at claude.ai/settings/usage and keep going."
const TOKEN = "fast-selected-account-token"
const P = "anthropic-ratelimit-unified-"
const NOW = new Date("2026-11-23T12:00:00.000Z")
const RESET = NOW.getTime() / 1_000 + 500_000

const lease: Parameters<typeof ownedInvoker>[0] = {
  handle: () => ({
    accountId: "account",
    owner: "owner",
    generation: 1n,
    signal: new AbortController().signal,
    valid: () => true,
    assert() {},
    remainingMs: () => 1_000,
  }),
}
/** Any other wrapper a deployment might add: it answers with a Response of its own making. */
const rebuilding =
  (invoke: SdkInvoker): SdkInvoker =>
  async (input) => {
    const response = await invoke(input)
    return new Response(await response.text(), response)
  }

async function refused(upstream: () => Response, stream = true) {
  const failures: SdkFailure[] = []
  const readings: unknown[] = []
  const invoke = rebuilding(
    ownedInvoker(
      lease,
      createFastInvoker({
        concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
        errorMaxBytes: 4_096,
        credential: async () => ({
          accessToken: TOKEN,
          expiresAt: Date.now() + 3_600_000,
          deviceId: "a".repeat(64),
          accountUuid: "11111111-1111-4111-8111-111111111111",
        }),
        resolveModel: (_, model) => model,
        sdk: async () => new Response("unexpected SDK fallback", { status: 500 }),
        fetch: async () => upstream(),
      }),
    ),
  )
  const input: SdkInvocation = {
    accountId: "account",
    configDir: "/isolated/account",
    model: "claude-sonnet-5-5",
    body: Buffer.from(
      JSON.stringify({
        max_tokens: 64,
        stream,
        messages: [{ role: "user", content: "hello" }],
      }),
    ),
    signal: new AbortController().signal,
    session: { kind: "fresh", reason: "no-session" },
    onRateLimit: (info) => readings.push(info),
    onRefusal: (failure) => failures.push(failure),
  }
  const response = await invoke(input)
  return { response, body: await response.text(), failure: failures.at(-1), readings }
}

const error = (
  status: number,
  type: string,
  message: string,
  headers: Record<string, string> = {},
) => Response.json({ type: "error", error: { type, message } }, { status, headers })

describe("a refusal's classification survives every wrapper", () => {
  for (const status of [400, 429]) {
    test(`an extra-usage-gated ${status} keeps its facts and cools nothing`, async () => {
      const r = await refused(() =>
        error(status, "invalid_request_error", `${GATED} ${TOKEN}`, {
          [`${P}status`]: "rejected",
          [`${P}reset`]: String(RESET),
          "retry-after": "17",
        }),
      )
      expect(r.response.status).toBe(429)
      expect(r.response.headers.get("retry-after")).toBe("17")
      expect(r.failure?.classification).toMatchObject({
        signal: "claude-sdk:extra-usage-gated",
        requestAttributable: true,
        permanentForRequest: true,
      })
      expect(r.failure?.classification.message).toContain("Third-party apps")
      expect(r.failure?.classification.message).not.toContain(TOKEN)
      expect(r.body).not.toContain("Third-party apps")
      // The same headers that would have cooled the Account for the request's own refusal.
      expect(r.readings).toEqual([])
    })
  }

  test("a genuine rate limit still reports the verdict its headers state", async () => {
    const r = await refused(() =>
      error(429, "rate_limit_error", "This request would exceed your account's rate limit.", {
        [`${P}status`]: "rejected",
        [`${P}reset`]: String(RESET),
        [`${P}representative-claim`]: "seven_day",
      }),
    )
    expect(r.failure?.classification).toMatchObject({ kind: "rate-limited" })
    expect(r.failure?.classification).not.toHaveProperty("modelScoped")
    expect(r.readings).toEqual([
      { status: "rejected", rateLimitType: "seven_day", resetsAt: RESET, overageStatus: null },
    ])
  })

  test("a spent Opus week holds Opus, not the Account", async () => {
    const r = await refused(() =>
      error(429, "rate_limit_error", "You have hit your weekly limit for this model.", {
        [`${P}status`]: "rejected",
        [`${P}reset`]: String(RESET),
        [`${P}representative-claim`]: "seven_day_opus",
        [`${P}5h-status`]: "allowed",
        [`${P}7d-status`]: "allowed",
      }),
    )
    expect(r.failure?.classification).toMatchObject({
      kind: "rate-limited",
      modelScoped: true,
      rateLimit: {
        limited: false,
        resetSource: "provider-reported",
        resetsAt: new Date(RESET * 1_000),
      },
    })
    const store = createSdkQuotaStore()
    const snapshot = r.readings.map((info) => store.ingest("account", info, NOW)).at(-1)
    expect(snapshot?.signal.limited).toBe(false)
    expect(snapshot?.windows.find((w) => w.window === "seven_day_opus")).toMatchObject({
      utilization: 1,
      resetsAt: new Date(RESET * 1_000),
    })
  })
})

describe("an error frame inside a 200, to a client still owed its whole answer", () => {
  const stream = (type: string) => () =>
    new Response(
      [
        {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", model: "x", content: [] },
        },
        { type: "error", error: { type, message: `upstream words ${TOKEN}` } },
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    )

  for (const [type, status, kind] of [
    ["overloaded_error", 529, "server-error"],
    ["rate_limit_error", 429, "rate-limited"],
    ["invalid_request_error", 400, "invalid-request"],
    ["a_type_nobody_named", 502, "server-error"],
  ] as const) {
    test(`${type} is the ${status} it would have been before the stream`, async () => {
      const r = await refused(stream(type), false)
      expect(r.response.status).toBe(status)
      expect(r.failure?.classification.kind).toBe(kind)
      expect(r.body).not.toContain("upstream words")
      expect(r.failure?.classification.message).not.toContain(TOKEN)
    })
  }

  test("a streaming client is handed the frame as it arrived", async () => {
    const r = await refused(stream("overloaded_error"), true)
    expect(r.response.status).toBe(200)
    expect(r.body).toContain("overloaded_error")
    expect(r.failure).toBeUndefined()
  })
})

describe("rejected quota headers on a 200", () => {
  const headers = {
    "content-type": "text/event-stream",
    [`${P}status`]: "rejected",
    [`${P}reset`]: String(RESET),
  }
  const answer = (frames: readonly object[]) => () =>
    new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(""), { headers })
  const start = {
    type: "message_start",
    message: { id: "m", type: "message", role: "assistant", model: "x", content: [] },
  }
  const verdict = { status: "rejected", resetsAt: RESET, overageStatus: null }

  test("say nothing of the Account when the body is the request's own refusal", async () => {
    const r = await refused(
      answer([start, { type: "error", error: { type: "invalid_request_error", message: GATED } }]),
      false,
    )
    expect(r.failure?.classification.requestAttributable).toBe(true)
    expect(r.readings).toEqual([])
  })

  test("are the Account's, once, when the body is its own rate limit", async () => {
    const r = await refused(
      answer([
        start,
        { type: "error", error: { type: "rate_limit_error", message: "rate limit exceeded" } },
      ]),
      false,
    )
    expect(r.failure?.classification.kind).toBe("rate-limited")
    expect(r.readings).toEqual([verdict])
  })

  test("are still reported for a completed, a truncated and a streamed answer", async () => {
    for (const [frames, stream, status] of [
      [[start, { type: "message_stop" }], false, 200],
      [[start], false, 502],
      [[start, { type: "message_stop" }], true, 200],
    ] as const) {
      const r = await refused(answer(frames), stream)
      expect(r.response.status).toBe(status)
      expect(r.readings).toEqual([verdict])
    }
  })
})
