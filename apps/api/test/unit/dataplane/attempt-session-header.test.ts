import { expect, test } from "bun:test"
import { openAiCompatibleDriver } from "../../../src/providers/drivers/openai-compatible"
import { opencodeGoDriver } from "../../../src/providers/drivers/opencode-go"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { account, cipher } from "./fixtures"

const HEADER = "x-opencode-session"

/** One attempt against a stub, answering with what the upstream received. */
async function sent(input: {
  readonly driver: typeof opencodeGoDriver
  readonly provider: "opencode-go" | "openai-compatible"
  readonly clientHeaders?: Headers
  readonly conversationId?: string
}): Promise<Headers> {
  const cryptor = cipher()
  let received: Headers | undefined
  await runAttempt({
    plan: {
      account: account("a", { provider: input.provider, cipher: cryptor }),
      driver: input.driver,
      dialect: "openai-chat",
      url: new URL("http://offline.test/chat/completions"),
      upstreamModel: "glm-5.3",
    },
    method: "POST",
    clientHeaders: input.clientHeaders ?? new Headers(),
    body: new TextEncoder().encode("{}"),
    timeoutMs: 1000,
    cipher: cryptor,
    ...(input.conversationId === undefined ? {} : { conversationId: input.conversationId }),
    fetch: async (request) => {
      received = request.headers
      return new Response("{}", { status: 200 })
    },
  })
  if (received === undefined) throw new Error("the attempt never reached the upstream")
  return received
}

const go = { driver: opencodeGoDriver, provider: "opencode-go" } as const

test("a conversation goes upstream under its id", async () => {
  const headers = await sent({ ...go, conversationId: "conversation-1" })

  expect(headers.get(HEADER)).toBe("conversation-1")
})

// Model listing and the account test call `runAttempt` directly. Without a one-off id the endpoint
// answers `400 MissingSessionID`, so an account could never list its models or pass its test.
test("a call that is no conversation still names one, fresh each time", async () => {
  const first = (await sent(go)).get(HEADER)
  const second = (await sent(go)).get(HEADER)

  expect(first).toMatch(/^[0-9a-f-]{36}$/)
  expect(second).not.toBe(first)
})

test("a client's own value never crosses the trust boundary", async () => {
  const clientHeaders = new Headers({ [HEADER]: "client-chosen" })
  const headers = await sent({ ...go, clientHeaders, conversationId: "conversation-1" })

  expect(headers.get(HEADER)).toBe("conversation-1")
})

test("a surface that declares no header is sent none", async () => {
  const headers = await sent({
    driver: openAiCompatibleDriver,
    provider: "openai-compatible",
    clientHeaders: new Headers({ [HEADER]: "client-chosen" }),
    conversationId: "conversation-1",
  })

  expect(headers.has(HEADER)).toBe(false)
})
