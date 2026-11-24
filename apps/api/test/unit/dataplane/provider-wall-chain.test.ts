/**
 * A `4xx` about one vendor's wire (`AttemptFailure.providerScoped`) skips that vendor's other
 * accounts and tries the next vendor; with none left the client gets the upstream's own answer.
 */
import { expect, test } from "bun:test"
import type { ProviderId } from "@multi-ai-router/core"
import { toErrorResponse } from "../../../src/errors/render"
import { createDispatcher, createHealthStore } from "../../../src/services/dataplane"
import { account, catalog, cipher, usageSink } from "./fixtures"

const CRYPTOR = cipher()
// Gemini's own wire: a tool call another vendor's model made carries no thought signature. (Through
// 2.76 this file used OpenRouter's "No endpoints found that support tool use", which is now read as
// that *account's* filter and walks to a sibling: `test/integration/account-scoped-failover.test.ts`.)
const REFUSAL =
  "Function call is missing a thought_signature in functionCall parts. This is required for tools to work correctly."

async function walk(accounts: readonly (readonly [string, ProviderId])[]) {
  const usage = usageSink()
  const health = createHealthStore()
  const hosts: string[] = []
  const dispatcher = createDispatcher({
    catalog: catalog(
      accounts.map(([id, provider], index) => {
        const entry = account(id, {
          provider,
          dialect: "openai-chat",
          cipher: CRYPTOR,
          baseUrl: `https://${provider}.test/v1`,
        })
        // Asked in the order listed: an unpinned walk can start at the last one and prove nothing.
        return { ...entry, snapshot: { ...entry.snapshot, priority: index } }
      }),
    ),
    options: { selection: { unpooledPolicy: "priority-failover" } },
    cipher: CRYPTOR,
    health,
    usage,
    fetch: async (request) => {
      const host = new URL((request as Request).url).host
      hosts.push(host)
      return host.includes("gemini")
        ? Response.json(
            { error: { code: 400, message: REFUSAL, status: "INVALID_ARGUMENT" } },
            { status: 400 },
          )
        : Response.json({ id: "ok", choices: [] })
    },
  })
  let status: number
  let text: string
  try {
    const response = await dispatcher.dispatch({
      ingress: "openai-chat",
      requestId: "req",
      key: {
        id: "key",
        name: "k",
        prefix: "k",
        scope: { kind: "all" },
        rateLimitRequests: null,
        rateLimitWindowSeconds: null,
        expiresAt: null,
      },
      request: new Request("http://router.test/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
      }),
    })
    status = response.status
    text = await response.text()
  } catch (error) {
    const rendered = toErrorResponse(error, "openai-chat")
    status = rendered.status
    text = JSON.stringify(rendered.body)
  }
  const active = accounts.every(([id]) => health.stateOf(id).breaker.status === "active")
  return { status, text, hosts, active }
}

test("with no other provider left the upstream's own 4xx is the answer, after one attempt", async () => {
  const r = await walk([
    ["a", "gemini"],
    ["b", "gemini"],
  ])

  expect(r.status).toBe(400)
  expect(r.text).toContain("thought_signature")
  expect(r.hosts).toEqual(["gemini.test"])
  expect(r.active).toBe(true)
})

test("another provider's account is tried, and no account is struck", async () => {
  const r = await walk([
    ["a", "gemini"],
    ["b", "gemini"],
    ["c", "zai"],
  ])

  expect(r.status).toBe(200)
  // One refusal, the second Gemini account skipped, then the other provider.
  expect(r.hosts).toEqual(["gemini.test", "zai.test"])
  expect(r.active).toBe(true)
})
