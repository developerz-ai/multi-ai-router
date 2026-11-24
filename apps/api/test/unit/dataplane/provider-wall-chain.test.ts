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
const REFUSAL =
  "No endpoints found that support tool use. To learn more about provider routing, visit: https://openrouter.ai/docs/provider-routing"

async function walk(accounts: readonly (readonly [string, ProviderId])[]) {
  const usage = usageSink()
  const health = createHealthStore()
  const hosts: string[] = []
  const dispatcher = createDispatcher({
    catalog: catalog(
      accounts.map(([id, provider]) =>
        account(id, {
          provider,
          dialect: "openai-chat",
          cipher: CRYPTOR,
          baseUrl: `https://${provider}.test/v1`,
        }),
      ),
    ),
    cipher: CRYPTOR,
    health,
    usage,
    fetch: async (request) => {
      const host = new URL((request as Request).url).host
      hosts.push(host)
      return host.includes("openrouter")
        ? Response.json({ error: { code: 404, message: REFUSAL } }, { status: 404 })
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
    ["a", "openrouter"],
    ["b", "openrouter"],
  ])

  expect(r.status).toBe(404)
  expect(r.text).toContain("support tool use")
  expect(r.hosts).toHaveLength(1)
  expect(r.active).toBe(true)
})

test("another provider's account is tried, and no account is struck", async () => {
  const r = await walk([
    ["a", "openrouter"],
    ["b", "openrouter"],
    ["c", "zai"],
  ])

  expect(r.status).toBe(200)
  expect(r.hosts.filter((host) => host.includes("openrouter")).length).toBeLessThanOrEqual(1)
  expect(r.active).toBe(true)
})
