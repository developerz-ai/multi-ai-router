import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test"
import type { ProviderId, ProviderPreferences } from "@multi-ai-router/core"
import {
  createAccountRepository,
  createDatabase,
  type DatabaseHandle,
  defaultMigrationsFolder,
  runMigrations,
} from "@multi-ai-router/db"
import { createRuntime } from "../../src/composition"
import { parseEnv } from "../../src/config/env"
import { createLogger } from "../../src/logging/logger"
import { createCredentialCipher } from "../../src/services/crypto/cipher"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

/**
 * An OpenRouter account's `provider` preferences reach the upstream in the body it is sent — on the
 * same-dialect passthrough and on a translated body alike — and nothing else changes: an account
 * without preferences, and every account whose surface takes no `provider` field, is sent the bytes
 * it was sent before. The upstream is a mock.
 *
 * The price-sort half boots the real composition root with the operator's env variable set, so a
 * regression in `createWarmState`'s forwarding cannot be hidden by a test that hands `loadCatalog`
 * the ids and preferences itself.
 */

const CODING: ProviderPreferences = {
  sort: "price",
  quantizations: ["fp8", "bf16"],
  allow_fallbacks: true,
}

function chatCompletion(): Response {
  return Response.json({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 1,
    model: "deepseek/deepseek-v4.1-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
  })
}

const CHAT = `{"model":"deepseek/deepseek-v4.1-flash",  "messages":[{"role":"user","content":"fix the bug"}]}`

const MESSAGES = JSON.stringify({
  model: "deepseek/deepseek-v4.1-flash",
  max_tokens: 64,
  messages: [{ role: "user", content: "fix the bug" }],
})

async function sent(input: {
  provider: ProviderId
  preferences?: ProviderPreferences
  path: "/v1/chat/completions" | "/v1/messages"
  body: string
}): Promise<string> {
  const { app, upstream } = harness({
    accounts: [
      account("a", {
        provider: input.provider,
        cipher: CRYPTOR,
        ...(input.preferences === undefined ? {} : { providerPreferences: input.preferences }),
      }),
    ],
    responses: [chatCompletion],
  })
  const res = await app.request(input.path, post(input.body, bearer()))
  expect(res.status).toBe(200)
  await res.text()
  expect(upstream.calls).toHaveLength(1)
  return upstream.calls[0]?.body ?? ""
}

describe("openrouter provider preferences on egress", () => {
  test("a same-dialect body carries the account's object, the client's bytes otherwise intact", async () => {
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: CHAT,
    })
    expect(body).toBe(
      `{"provider":{"sort":"price","quantizations":["fp8","bf16"],"allow_fallbacks":true},${CHAT.slice(1)}`,
    )
  })

  test("a client's own provider field wins field by field", async () => {
    const client = JSON.stringify({ ...JSON.parse(CHAT), provider: { sort: "throughput" } })
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: client,
    })
    expect(JSON.parse(body).provider).toEqual({ ...CODING, sort: "throughput" })
  })

  test("a translated (Anthropic-wire) body carries it too", async () => {
    const body = await sent({
      provider: "openrouter",
      preferences: CODING,
      path: "/v1/messages",
      body: MESSAGES,
    })
    expect(JSON.parse(body).provider).toEqual(CODING)
  })

  test("an openrouter account with no preferences is sent the client's exact bytes", async () => {
    expect(await sent({ provider: "openrouter", path: "/v1/chat/completions", body: CHAT })).toBe(
      CHAT,
    )
  })

  test("an account whose surface takes no provider field never gets one, whatever it holds", async () => {
    const passthrough = await sent({
      provider: "deepseek",
      preferences: CODING,
      path: "/v1/chat/completions",
      body: CHAT,
    })
    expect(passthrough).toBe(CHAT)
    const translated = await sent({
      provider: "deepseek",
      preferences: CODING,
      path: "/v1/messages",
      body: MESSAGES,
    })
    expect(translated).not.toContain('"provider"')
  })
})

const url = process.env.DATABASE_URL ?? ""
const baseEnv: Record<string, string> = {
  DATABASE_URL: url,
  ADMIN_OIDC_ISSUER_URL: "https://sso.test",
  ADMIN_OIDC_CLIENT_ID: "multi-ai-router-test",
  ADMIN_OIDC_REDIRECT_URI: "https://router.test/api/admin/auth/oidc/callback",
  ADMIN_OIDC_ADMIN_EMAIL: "admin@test",
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
}
const logger = createLogger({ level: "error", write: () => undefined })

let handle: DatabaseHandle | undefined
let runtime: ReturnType<typeof createRuntime> | undefined
let accountId = ""

beforeAll(async () => {
  if (url === "") return
  await runMigrations({ url, migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url, maxConnections: 2 })
  const row = await createAccountRepository(handle.db).create({
    label: `price-sort fixture ${crypto.randomUUID()}`,
    provider: "openrouter",
    authMaterial: createCredentialCipher({ key: new Uint8Array(32).fill(7) }).encrypt(
      "fixture-key",
    ),
  })
  accountId = row.id
  const env = parseEnv({ ...baseEnv, OPENROUTER_PRICE_SORT_ACCOUNTS: accountId })
  runtime = createRuntime({
    env,
    database: handle.db,
    sql: handle.sql,
    dbPoolStats: handle.poolStats,
    logger,
  })
  await runtime.catalog.refresh()
}, 60_000)

afterAll(async () => {
  try {
    if (accountId !== "" && handle !== undefined)
      await createAccountRepository(handle.db).delete(accountId)
  } finally {
    await handle?.close()
    handle = undefined
    runtime = undefined
  }
})

async function runtimeSent(body: string): Promise<string> {
  if (runtime === undefined) throw new Error("runtime missing")
  const calls: string[] = []
  const upstream = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: string | URL | Request) => {
        if (!(input instanceof Request)) throw new Error("expected upstream Request")
        calls.push(await input.clone().text())
        return chatCompletion()
      },
      { preconnect: fetch.preconnect },
    ),
  )
  try {
    const res = await runtime.dispatcher.dispatch({
      ingress: "openai-chat",
      request: new Request("http://router.test/v1/chat/completions", post(body)),
      key: {
        id: crypto.randomUUID(),
        name: "test",
        prefix: "test",
        scope: { kind: "accounts", accountIds: [accountId] },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      requestId: crypto.randomUUID(),
    })
    expect(res.status).toBe(200)
    await res.text()
    expect(calls).toHaveLength(1)
    return calls[0] ?? ""
  } finally {
    upstream.mockRestore()
  }
}

describe.skipIf(url === "")("price-sort defaults on the spend-driving OpenRouter models", () => {
  for (const model of ["deepseek/deepseek-v4.1-flash", "tencent/hy4-flash"]) {
    test(`${model}: price-sort reaches the upstream and the model name is untouched`, async () => {
      const body = JSON.stringify({ model, messages: [{ role: "user", content: "fix" }] })
      const sentBody = JSON.parse(await runtimeSent(body))
      expect(sentBody.provider).toEqual(CODING)
      expect(sentBody.model).toBe(model)
    })
  }

  test("a client-supplied provider still wins field by field on an injected account", async () => {
    const body = JSON.stringify({
      model: "deepseek/deepseek-v4.1-flash",
      provider: { sort: "throughput", require_parameters: true },
      messages: [{ role: "user", content: "fix" }],
    })
    expect(JSON.parse(await runtimeSent(body)).provider).toEqual({
      ...CODING,
      sort: "throughput",
      require_parameters: true,
    })
  })
})
