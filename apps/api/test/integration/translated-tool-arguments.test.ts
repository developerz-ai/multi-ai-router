import { expect, test } from "bun:test"
import { account, jsonResponse } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

// Ruling on plan 101, 06.4: undecodable tool arguments fail honestly with a typed translation
// error — never a body carrying `input: {}`. A non-streamed answer is read whole before it is
// converted, so the status is held and the client gets a typed `502` in its own dialect, with the
// attempt's row saying why.
test("a translated answer with undecodable tool arguments fails honestly, with its row", async () => {
  const { app, usage } = harness({
    accounts: [account("or-1", { provider: "openrouter", apiKey: "sk-or", cipher: CRYPTOR })],
    responses: [
      () =>
        jsonResponse(200, {
          id: "chatcmpl-1",
          model: "gpt-4o",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: { name: "lookup", arguments: '{"city": "Par' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        }),
    ],
  })

  const res = await app.request("/v1/messages", post(undefined, bearer()))
  const body = (await res.json()) as {
    readonly type: string
    readonly error: {
      readonly type: string
      readonly router: { readonly retryable: boolean; readonly signal: string }
    }
  }
  await settle()

  expect(res.status).toBe(502)
  expect(body.type).toBe("error")
  expect(body.error.router).toMatchObject({
    retryable: false,
    signal: "translation_protocol_error",
  })
  expect(JSON.stringify(body)).not.toContain('"input":{}')
  expect(usage.rows).toHaveLength(1)
  expect(usage.rows[0]).toMatchObject({
    accountId: "or-1",
    outcome: "router_error",
    errorClass: "translation_protocol_error",
    responseStatus: 502,
  })
})
