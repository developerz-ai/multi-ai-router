import { describe, expect, test } from "bun:test"
import { createSdkConcurrency, createSdkInvoker, createSessionStore } from "../../src/providers"
import { memorySessions, sdkQueryStream, sdkTurn, wireEvent } from "../unit/claude-sdk/fixtures"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

const cli = { ok: true, source: "platform_package", path: "/stub/claude", bytes: 1 } as const
const message = { model: "claude-opus-5", messages: [{ role: "user", content: "hi" }] }

function failedTurn() {
  return {
    async *[Symbol.asyncIterator]() {
      yield wireEvent({
        type: "message_start",
        message: { id: "m", role: "assistant", model: "claude-opus-5", content: [] },
      })
      yield {
        type: "result",
        is_error: true,
        terminal_reason: "api_error",
        api_error_status: 401,
        result: "Failed to authenticate: OAuth session expired and could not be refreshed",
      }
    },
  }
}

describe("SDK boundary rejection through the data plane", () => {
  for (const fields of [
    { messages: [] },
    { messages: [{ role: "user", content: [{ text: "missing type" }] }] },
    { tools: [{ type: "web_search_20250305", name: "web_search" }] },
    { tools: [{ type: "computer_20250124", name: "computer" }] },
  ]) {
    test(`invalid request ${JSON.stringify(fields)} returns 400 before query`, async () => {
      let calls = 0
      const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
      const { app, usage, health } = harness({
        accounts: [subscriptionAccount("sub")],
        responses: [],
        invokeSdk: createSdkInvoker({
          concurrency,
          resolveCli: () => cli,
          runQuery: () => {
            calls += 1
            return failedTurn()
          },
        }),
      })
      const response = await app.request(
        "/v1/messages",
        post(JSON.stringify({ ...message, ...fields }), bearer()),
      )
      expect(response.status).toBe(400)
      const text = await response.text()
      if ("tools" in fields) expect(text).toContain("tools[0].type")
      expect(calls).toBe(0)
      expect(concurrency.inFlight).toBe(0)
      expect(health.stateOf("sub").breaker.consecutiveFailures).toBe(0)
      await settle()
      expect(usage.rows).toHaveLength(1)
      expect(usage.rows[0]?.outcome).toBe("client_error")
    })
  }

  test("start-only failed result is classified before sending a JSON response", async () => {
    const { app, health, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      invokeSdk: createSdkInvoker({
        concurrency: createSdkConcurrency({ global: 1, perAccount: 1 }),
        resolveCli: () => cli,
        runQuery: failedTurn,
      }),
    })
    const response = await app.request("/v1/messages", post(JSON.stringify(message), bearer()))
    expect(response.status).toBe(502)
    expect(await response.text()).not.toContain("OAuth session expired")
    expect(health.stateOf("sub").breaker.status).toBe("needs_reauth")
    await settle()
    expect(usage.rows[0]?.outcome).toBe("upstream_auth_failed")
  })

  test("a failed result after streaming starts ends with an error and cannot retry", async () => {
    let calls = 0
    const { app } = harness({
      accounts: [subscriptionAccount("a"), subscriptionAccount("b")],
      responses: [],
      invokeSdk: createSdkInvoker({
        concurrency: createSdkConcurrency({ global: 2, perAccount: 1 }),
        resolveCli: () => cli,
        runQuery: () => {
          calls += 1
          return failedTurn()
        },
      }),
    })
    const response = await app.request(
      "/v1/messages",
      post(JSON.stringify({ ...message, stream: true }), bearer()),
    )
    const text = await response.text()
    expect(text).toContain("event: message_start")
    expect(text.match(/event: error/g)).toHaveLength(1)
    expect(text).not.toContain("event: message_stop")
    expect(calls).toBe(1)
  })
})

for (const stream of [false, true]) {
  test(`session lineage is committed before a delayed gauge (stream=${stream})`, async () => {
    let releaseGauge = () => {}
    const gauge = new Promise<void>((resolve) => {
      releaseGauge = resolve
    })
    const repository = memorySessions()
    const concurrency = createSdkConcurrency({ global: 2, perAccount: 2 })
    const resumes: (string | undefined)[] = []
    const { app } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      sessions: createSessionStore({ repository, now: () => new Date() }),
      invokeSdk: createSdkInvoker({
        concurrency,
        resolveCli: () => cli,
        usageGauge: { observe: () => gauge },
        runQuery: ({ options }) => {
          resumes.push(options.resume)
          return sdkQueryStream({
            sessionId: "sdk-delayed-gauge",
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
          })
        },
      }),
    })
    const send = (messages: readonly { role: string; content: string }[]) =>
      app.request(
        "/v1/messages",
        post(JSON.stringify({ ...message, messages, stream }), {
          ...bearer(),
          "x-session-id": "delayed-gauge",
        }),
      )
    try {
      await (await send(message.messages)).text()
      expect(repository.writes.at(-1)?.sdkSessionId).toBe("sdk-delayed-gauge")
      expect(concurrency.inFlight).toBe(1)
      await (
        await send([
          ...message.messages,
          { role: "assistant", content: "hi" },
          { role: "user", content: "continue" },
        ])
      ).text()
      expect(resumes).toEqual([undefined, "sdk-delayed-gauge"])
      expect(repository.writes.at(-1)?.lineageState?.prefixHashes).toHaveLength(3)
      releaseGauge()
      await settle()
      expect(repository.writes).toHaveLength(2)
      expect(repository.writes.at(-1)?.lineageState?.prefixHashes).toHaveLength(3)
      expect(concurrency.inFlight).toBe(0)
    } finally {
      releaseGauge()
    }
  })
}
