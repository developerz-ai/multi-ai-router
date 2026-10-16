import { expect, test } from "bun:test"
import { createFastInvoker } from "../../src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../src/providers/claude-sdk/concurrency"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

for (const stream of [true, false]) {
  test(`fast mode refuses proxy HTTP 200 before client bytes and records failure (stream=${stream})`, async () => {
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    let sdkCalls = 0
    const invokeSdk = createFastInvoker({
      concurrency,
      errorMaxBytes: 4096,
      credential: async () => ({
        accessToken: "private-selected-account",
        expiresAt: Date.now() + 3_600_000,
        deviceId: "a".repeat(64),
        accountUuid: "11111111-1111-4111-8111-111111111111",
      }),
      resolveModel: (_, model) => model,
      sdk: async () => {
        sdkCalls++
        return new Response("unexpected fallback")
      },
      fetch: async () =>
        new Response("<html>private-selected-account</html>", {
          headers: { "content-type": "text/html" },
        }),
    })
    const { app, usage } = harness({
      accounts: [subscriptionAccount("sub")],
      responses: [],
      maxAttempts: 1,
      invokeSdk,
    })
    const response = await app.request(
      "/v1/messages",
      post(
        JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 64,
          stream,
          messages: [{ role: "user", content: "hello" }],
        }),
        bearer(),
      ),
    )
    const text = await response.text()
    await settle()
    expect(response.status).toBe(502)
    expect(text).not.toContain("private-selected-account")
    expect(text).not.toContain("<html>")
    expect(sdkCalls).toBe(0)
    expect(concurrency.inFlight).toBe(0)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({ accountId: "sub", outcome: "upstream_error" })
  })
}
