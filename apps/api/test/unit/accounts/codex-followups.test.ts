import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import { createDiscoverModelsService, createTestNowService } from "../../../src/services/accounts"
import { listUpstreamModels } from "../../../src/services/models"
import { accountRow as durableAccountRow } from "../../support/account-row"

/**
 * Production, v2.18.0, a connected ChatGPT/Codex account: "Discover models" answered
 * `http-status:400` (the listing needs `client_version`), "Test now" answered `http-status:400`
 * (its probe body broke every Codex surface rule), and neither logged what the upstream said.
 * The upstream here is a mock of chatgpt.com/backend-api/codex; nothing reaches it.
 */

const NOW = new Date("2026-10-04T22:00:00.000Z")
const ACCESS = `h.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-c" } })).toString("base64url")}.s`

function codexRow(): AccountRow {
  return durableAccountRow({
    id: "acc-c",
    label: "codex",
    provider: "openai-oauth",
    status: "active",
    // Identity cipher below: the stored OAuth material as `writeStoredOAuth` lays it out.
    authMaterial: JSON.stringify({
      accessToken: ACCESS,
      refreshToken: "rt",
      providerAccountId: "acct-c",
    }),
    configDir: null,
    tokenExpiresAt: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    billing: "subscription",
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
  })
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

const CODEX_MODELS = {
  models: [
    { slug: "gpt-5.5", display_name: "GPT-5.5", context_window: 272_000, visibility: "list" },
    { slug: "gpt-5.4-mini", display_name: "mini", max_context_window: 400_000, visibility: "hide" },
  ],
}

describe("A. the Codex model listing", () => {
  test("asks with client_version and no page size, and reads {models: [{slug}]}", async () => {
    const seen: string[] = []
    const listed = await listUpstreamModels(
      {
        cipher: { decrypt: (value) => value },
        timeoutMs: 5_000,
        fetch: async (request) => {
          seen.push(request.url)
          const url = new URL(request.url)
          return url.searchParams.has("client_version") && !url.searchParams.has("limit")
            ? json(200, CODEX_MODELS)
            : json(400, { detail: "client_version is required" })
        },
      },
      codexRow(),
    )
    expect(seen[0]).toBe("https://chatgpt.com/backend-api/codex/models?client_version=0.160.0")
    expect(listed).toEqual({
      ok: true,
      entries: [
        { id: "gpt-5.4-mini", contextTokens: 400_000, maxOutputTokens: null },
        { id: "gpt-5.5", contextTokens: 272_000, maxOutputTokens: null },
      ],
    })
  })

  test("a refused listing is logged with the upstream's own words, bounded, never the token", async () => {
    const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
    const service = createDiscoverModelsService({
      accounts: { findById: async () => codexRow() },
      write: { update: async () => ({ ok: true, value: {} }) as never },
      cipher: { decrypt: (value) => value },
      audit: { record: async () => {} },
      timeoutMs: 5_000,
      fetch: async () =>
        json(400, { detail: `client_version is required ${ACCESS} ${"x".repeat(400)}` }),
      log: { warn: (msg, fields) => void warnings.push({ msg, fields }) },
      reasonMaxChars: 60,
    })
    const result = await service.discover("acc-c")
    expect(result.ok).toBe(false)
    expect(warnings).toHaveLength(1)
    const line = JSON.stringify(warnings[0])
    expect(warnings[0]?.fields?.status).toBe(400)
    expect(String(warnings[0]?.fields?.upstreamMessage)).toContain("client_version is required")
    expect(String(warnings[0]?.fields?.upstreamMessage).length).toBeLessThanOrEqual(60)
    expect(line).not.toContain(ACCESS)
  })
})

function sse(events: ReadonlyArray<readonly [string, unknown]>): Response {
  return new Response(
    events
      .map(
        ([event, data]) =>
          `event: ${event}\ndata: ${JSON.stringify({ type: event, ...(data as object) })}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  )
}

function testNow(fetch: (request: Request) => Promise<Response>) {
  const warnings: { msg: string; fields?: Record<string, unknown> }[] = []
  const service = createTestNowService({
    accounts: { findById: async () => codexRow() },
    cipher: { decrypt: (value) => value },
    audit: { record: async () => {} },
    cooldownSeconds: 0,
    timeoutMs: 5_000,
    now: () => NOW,
    fetch,
    log: { warn: (msg, fields) => void warnings.push({ msg, fields }) },
    reasonMaxChars: 120,
  })
  return { service, warnings }
}

describe("B. Test now against a Codex account", () => {
  test("sends a Codex-valid body and reads the stream to its completed event", async () => {
    const bodies: Record<string, unknown>[] = []
    const { service } = testNow(async (request) => {
      bodies.push(JSON.parse(await request.text()) as Record<string, unknown>)
      return sse([
        ["response.created", { response: { id: "r" } }],
        ["response.completed", { response: { id: "r", status: "completed", output: [] } }],
      ])
    })
    const result = await service.test("acc-c", { model: "gpt-5.5" })
    expect(result).toMatchObject({ ok: true, value: { outcome: "ok" } })
    const sent = bodies[0] ?? {}
    expect(sent.stream).toBe(true)
    expect(sent.store).toBe(false)
    expect(sent.instructions).toBe("")
    expect("max_output_tokens" in sent).toBe(false)
    expect(sent.model).toBe("gpt-5.5")
  })

  test('sends `input` as a list of items, asking for a stream (prod: 400 "Input must be a list")', async () => {
    const sent: { body: Record<string, unknown>; accept: string | null }[] = []
    const { service } = testNow(async (request) => {
      sent.push({
        body: JSON.parse(await request.text()) as Record<string, unknown>,
        accept: request.headers.get("accept"),
      })
      return sse([["response.completed", { response: { id: "r", status: "completed" } }]])
    })
    await service.test("acc-c", { model: "gpt-5.5" })
    expect(sent[0]?.body.input).toEqual([
      { type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] },
    ])
    expect(sent[0]?.accept).toBe("text/event-stream")
  })

  test("a forced stream without a content-type is still read to its terminal event", async () => {
    const { service } = testNow(async () => {
      const response = sse([["response.created", { response: { id: "r" } }]])
      response.headers.delete("content-type")
      return response
    })
    const result = await service.test("acc-c", { model: "gpt-5.5" })
    expect(result).toMatchObject({ ok: true, value: { outcome: "failed" } })
  })

  test("a 200 stream that ends without a completed response is a failure, not ok", async () => {
    const { service } = testNow(async () => sse([["response.created", { response: { id: "r" } }]]))
    const result = await service.test("acc-c", { model: "gpt-5.5" })
    expect(result).toMatchObject({ ok: true, value: { outcome: "failed" } })
  })

  test("C. a refusal logs the upstream's own (scrubbed, bounded) message", async () => {
    const { service, warnings } = testNow(async () =>
      json(400, { detail: `Unsupported parameter: max_output_tokens (${ACCESS})` }),
    )
    const result = await service.test("acc-c", { model: "gpt-5.5" })
    expect(result).toMatchObject({ ok: true, value: { outcome: "failed" } })
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]?.fields?.detail)).toContain(
      "Unsupported parameter: max_output_tokens",
    )
    expect(JSON.stringify(warnings)).not.toContain(ACCESS)
    expect(JSON.stringify(result)).not.toContain("Unsupported parameter")
  })
})
