import { describe, expect, test } from "bun:test"
import {
  classifySdkFailure,
  createSdkQuotaStore,
  createSessionStore,
  readSdkRequest,
  renderSdkResponse,
  subprocessEnv,
} from "../../../src/providers"
import { memorySessions, messagesBody, sdkQueryStream, sdkTurn, wireEvent } from "./fixtures"

const NOW = new Date("2026-10-02T00:00:00Z")
const opening = messagesBody([{ role: "user", text: "hello" }])
const grown = messagesBody([
  { role: "user", text: "hello" },
  { role: "assistant", text: "invented answer" },
  { role: "user", text: "continue" },
])

function store() {
  return createSessionStore({ repository: memorySessions(), now: () => NOW })
}

function resolve(
  sessions: ReturnType<typeof store>,
  apiKeyId: string,
  sessionKey: string,
  body: Uint8Array,
  keySource: "header" | "fingerprint" = "header",
  accountId = "account",
) {
  return sessions.resolve({ apiKeyId, sessionKey, body, keySource, accountId })
}

describe("session fingerprint ownership", () => {
  for (const source of ["header", "fingerprint"] as const) {
    test(`${source} aliases cannot cross router keys`, () => {
      const sessions = store()
      const first = resolve(sessions, "victim", "first", opening, source)
      first.remember("private-sdk-session")
      first.release()
      const attack = resolve(sessions, "attacker", "second", grown, source)
      expect(attack.plan).toEqual({ kind: "fresh", reason: "no-session" })
      attack.release()
    })
  }

  test("same-key alias continuity holds while concurrent aliases detach", () => {
    const sessions = store()
    const first = resolve(sessions, "key", "first", opening)
    first.remember("sdk-session")
    first.release()
    const second = resolve(sessions, "key", "second", grown)
    expect(second.plan).toMatchObject({ kind: "resume", sdkSessionId: "sdk-session" })
    const concurrent = resolve(sessions, "key", "third", grown)
    expect(concurrent.plan).toEqual({ kind: "fresh", reason: "session-busy" })
    concurrent.remember("throwaway")
    concurrent.release()
    second.remember("sdk-session")
    const original = resolve(sessions, "key", "first", grown)
    expect(original.plan).toEqual({ kind: "fresh", reason: "session-busy" })
    original.release()
    second.release()
    const later = resolve(sessions, "key", "first", grown)
    expect(later.plan).toMatchObject({ kind: "resume", sdkSessionId: "sdk-session" })
    later.release()
  })

  test("different explicit conversations can share an opening and resume independently", () => {
    const sessions = store()
    const first = resolve(sessions, "key", "first", opening)
    first.remember("sdk-first")
    const second = resolve(sessions, "key", "second", opening)
    expect(second.plan).toEqual({ kind: "fresh", reason: "replay" })
    second.remember("sdk-second")
    first.release()
    second.release()
    const nextFirst = resolve(sessions, "key", "first", grown)
    const nextSecond = resolve(sessions, "key", "second", grown)
    expect(nextFirst.plan).toMatchObject({ kind: "resume", sdkSessionId: "sdk-first" })
    expect(nextSecond.plan).toMatchObject({ kind: "resume", sdkSessionId: "sdk-second" })
    nextFirst.release()
    nextSecond.release()
  })

  test("account and key claims are independent", () => {
    const sessions = store()
    const first = resolve(sessions, "key", "first", opening)
    first.remember("sdk-session")
    for (const [key, account] of [
      ["other-key", "account"],
      ["key", "other-account"],
    ]) {
      const other = resolve(sessions, key ?? "", "second", grown, "header", account)
      expect(other.plan).toEqual({ kind: "fresh", reason: "no-session" })
      other.release()
    }
    first.release()
  })
})

describe("SDK request validation", () => {
  for (const request of [
    null,
    {},
    { messages: [] },
    { messages: "bad" },
    { messages: [{ role: "user", content: [{ text: "hello" }] }] },
  ]) {
    test(`refuses invalid envelope ${JSON.stringify(request)}`, () => {
      const body = request === null ? null : new TextEncoder().encode(JSON.stringify(request))
      let failure: unknown
      try {
        readSdkRequest(body)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeDefined()
      expect(classifySdkFailure(failure).classification.kind).toBe("invalid-request")
    })
  }
  for (const type of ["web_search_20250305", "computer_20250124", "bash_20250124"]) {
    test(`refuses native tool ${type} with its field path`, () => {
      const body = new TextEncoder().encode(
        JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          tools: [{ type, name: "native" }],
        }),
      )
      expect(() => readSdkRequest(body)).toThrow("tools[0].type")
    })
  }
})

describe("SDK quota expiry", () => {
  test("an expired weekly rejection cannot cool a successful new five-hour event", () => {
    const quotas = createSdkQuotaStore()
    quotas.ingest(
      "a",
      { status: "rejected", rateLimitType: "seven_day", resetsAt: NOW.getTime() + 1000 },
      NOW,
    )
    const next = quotas.ingest(
      "a",
      { status: "allowed", rateLimitType: "five_hour" },
      new Date(NOW.getTime() + 2000),
    )
    expect(next?.signal.limited).toBe(false)
  })

  test("a new rejection without reset does not inherit an expired instant", () => {
    const quotas = createSdkQuotaStore()
    quotas.ingest(
      "a",
      { status: "rejected", rateLimitType: "five_hour", resetsAt: NOW.getTime() + 1000 },
      NOW,
    )
    const next = quotas.ingest(
      "a",
      { status: "rejected", rateLimitType: "five_hour" },
      new Date(NOW.getTime() + 2000),
    )
    expect(next?.signal.limited).toBe(true)
    expect(next?.signal.resetsAt).toBeUndefined()
  })

  test("all independently rejected windows must reset before serving", () => {
    const quotas = createSdkQuotaStore()
    quotas.ingest(
      "a",
      { status: "rejected", rateLimitType: "five_hour", resetsAt: NOW.getTime() + 1000 },
      NOW,
    )
    const next = quotas.ingest(
      "a",
      { status: "rejected", rateLimitType: "seven_day", resetsAt: NOW.getTime() + 2000 },
      NOW,
    )
    expect(next?.signal.resetsAt).toEqual(new Date(NOW.getTime() + 2000))
  })
})

test("provider selectors and router telemetry secrets never enter SDK subprocesses", () => {
  const poison = Object.fromEntries(
    [
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_PROFILE",
      "GOOGLE_APPLICATION_CREDENTIALS",
      "CLOUD_ML_REGION",
      "SENTRY_DSN",
      "AZURE_CLIENT_SECRET",
    ].map((key) => [key, "secret"]),
  )
  const env = subprocessEnv({ configDir: "/isolated", inherited: { ...poison, PATH: "/bin" } })
  expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/isolated" })
})

const failure = {
  is_error: true,
  terminal_reason: "api_error",
  result: "Failed to authenticate: OAuth session expired and could not be refreshed",
}
for (const content of [false, true]) {
  test(`actual SDK failure after ${content ? "closed text" : "start only"} is never successful JSON`, async () => {
    const messages = content
      ? sdkQueryStream({
          turns: [
            sdkTurn({
              blocks: [
                [
                  { type: "text", text: "" },
                  { type: "text_delta", text: "hi" },
                ],
              ],
            }),
          ],
          result: failure,
        })
      : {
          async *[Symbol.asyncIterator]() {
            yield wireEvent({
              type: "message_start",
              message: { id: "msg", role: "assistant", model: "m", content: [] },
            })
            yield { type: "result", ...failure }
          },
        }
    await expect(renderSdkResponse({ messages, model: "m", stream: false })).rejects.toThrow(
      "Failed to authenticate",
    )
  })
}

for (const content of [false, true]) {
  test(`streaming SDK failure after ${content ? "closed text" : "start only"} emits one terminal error`, async () => {
    const messages = content
      ? sdkQueryStream({
          turns: [
            sdkTurn({
              blocks: [
                [
                  { type: "text", text: "" },
                  { type: "text_delta", text: "hi" },
                ],
              ],
            }),
          ],
          result: failure,
        })
      : {
          async *[Symbol.asyncIterator]() {
            yield wireEvent({
              type: "message_start",
              message: { id: "msg", role: "assistant", model: "m", content: [] },
            })
            yield { type: "result", ...failure }
          },
        }
    const response = await renderSdkResponse({ messages, model: "m", stream: true })
    const text = await response.text()
    expect(response.status).toBe(200)
    expect(text.match(/event: error/g)).toHaveLength(1)
    expect(text).not.toContain("event: message_stop")
    expect(text).not.toContain("OAuth session expired")
  })
}

test("a new gauge cannot attach a future reset to an already expired rejection", () => {
  const quotas = createSdkQuotaStore()
  quotas.ingest(
    "a",
    { status: "rejected", rateLimitType: "five_hour", resetsAt: NOW.getTime() + 1000 },
    NOW,
  )
  const later = new Date(NOW.getTime() + 2000)
  expect(quotas.snapshot("a", later)?.signal.limited).toBe(false)
  quotas.ingestGauge(
    "a",
    {
      available: true,
      subscriptionType: null,
      windows: [{ kind: "five_hour", utilization: 0.1, resetsAt: new Date(NOW.getTime() + 3000) }],
    },
    later,
  )
  expect(quotas.snapshot("a", later)?.signal.limited).toBe(false)
})
