import { expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post } from "./harness"

test("Console login relays bytes with selected workspace auth and opaque session affinity", async () => {
  const seat = {
    ...account("console", {
      provider: "opencode-oauth",
      cipher: CRYPTOR,
      baseUrl: "https://opencode.ai/inference/openai/v1",
    }),
    dialect: "openai-chat" as const,
    authMaterial: CRYPTOR.encrypt(
      JSON.stringify({
        accessToken: "test-access",
        refreshToken: "test-refresh",
        providerAccountId: "org-selected",
      }),
    ),
  }
  const reply = () =>
    Response.json({
      id: "chatcmpl-1",
      object: "chat.completion",
      created: 1,
      model: "big-pickle",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: "TRACE_42",
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 1 },
    })
  const { app, upstream } = harness({ accounts: [seat], responses: [reply] })
  const body = '{ "model": "big-pickle", "messages": [{"role":"user","content":"hi"}], "extra":42 }'
  for (const session of ["first", "first", "second"]) {
    const result = await app.request(
      "/v1/chat/completions",
      post(body, {
        ...bearer(),
        "x-session-id": session,
        "x-opencode-org-id": "attacker-org",
        "x-opencode-session": "attacker-session",
      }),
    )
    expect(result.status).toBe(200)
    await result.text()
  }
  for (const call of upstream.calls) {
    expect(call.url).toBe("https://opencode.ai/inference/openai/v1/chat/completions")
    expect(call.body).toBe(body)
    expect(call.headers.get("authorization")).toBe("Bearer test-access")
    expect(call.headers.get("x-opencode-org-id")).toBe("org-selected")
    expect(call.headers.get("user-agent")).toBe("developerz.ai")
    expect(call.headers.get("x-opencode-session")).toMatch(/^[0-9a-f-]{36}$/)
    expect(call.headers.get("x-opencode-session")).not.toBe("attacker-session")
  }
  const sessions = upstream.calls.map((call) => call.headers.get("x-opencode-session"))
  expect(sessions[0]).toBe(sessions[1])
  expect(sessions[2]).not.toBe(sessions[0])
})
