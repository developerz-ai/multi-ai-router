import { afterAll, describe, expect, test } from "bun:test"
import { openAiCompatibleDriver } from "../../../src/providers/drivers/openai-compatible"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import type { FetchLike } from "../../../src/services/dataplane/types"
import { account, cipher } from "./fixtures"

const PASSWORD = "proxy-secret-pw"

/** A local HTTP proxy that records what reached it, and an origin that records what got past it. */
const seen = { proxied: [] as string[], auth: [] as (string | null)[], origin: 0 }
let refuse = false
const origin = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seen.origin += 1
    return new Response(`data: ${await request.text()}\n\n`, {
      headers: { "content-type": "text/event-stream" },
    })
  },
})
const proxy = Bun.serve({
  port: 0,
  fetch: async (request) => {
    seen.proxied.push(request.url)
    seen.auth.push(request.headers.get("proxy-authorization"))
    if (refuse) return new Response("no", { status: 407 })
    return fetch(`http://127.0.0.1:${origin.port}/v1/chat/completions`, {
      method: "POST",
      body: await request.text(),
    })
  },
})
afterAll(() => {
  origin.stop(true)
  proxy.stop(true)
})

const direct: FetchLike = (request, init) => fetch(request, init)

async function attempt(proxyUrl: string | null, call: FetchLike = direct) {
  const cryptor = cipher()
  return runAttempt({
    plan: {
      account: {
        ...account("a", { provider: "openai-compatible", cipher: cryptor }),
        ...(proxyUrl === null ? {} : { egressProxy: cryptor.encrypt(proxyUrl) }),
      },
      driver: openAiCompatibleDriver,
      dialect: "openai-chat",
      url: new URL(`http://127.0.0.1:${origin.port}/v1/chat/completions`),
      upstreamModel: "m",
    },
    method: "POST",
    clientHeaders: new Headers(),
    body: new TextEncoder().encode('{"hello":1}'),
    timeoutMs: 2000,
    cipher: cryptor,
    fetch: call,
  })
}

describe("an account's egress proxy", () => {
  test("a proxy that refuses is a transport failure, never a direct call", async () => {
    refuse = true
    const before = seen.origin
    const outcome = await attempt(`http://u:${PASSWORD}@127.0.0.1:${proxy.port}`)
    refuse = false

    expect(outcome).toMatchObject({ kind: "failure", failure: { kind: "connection" } })
    expect(seen.origin).toBe(before)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })

  test("a proxy that is not there is a transport failure, never a direct call", async () => {
    const before = seen.origin
    const outcome = await attempt(`http://u:${PASSWORD}@127.0.0.1:1`)

    expect(outcome).toMatchObject({ kind: "failure", failure: { kind: "connection" } })
    expect(seen.origin).toBe(before)
    expect(JSON.stringify(outcome)).not.toContain(PASSWORD)
  })

  test("the call leaves through the proxy, body intact and credentials presented to it", async () => {
    seen.proxied.length = 0
    seen.auth.length = 0
    const outcome = await attempt(`http://u:${PASSWORD}@127.0.0.1:${proxy.port}`)

    expect(outcome.kind).toBe("success")
    expect(seen.proxied).toHaveLength(1)
    expect(seen.auth).toEqual([`Basic ${btoa(`u:${PASSWORD}`)}`])
    if (outcome.kind === "success") expect(await outcome.response.text()).toContain('{"hello":1}')
  })

  test("an account without one is fetched with no init at all", async () => {
    const inits: unknown[] = []
    await attempt(null, async (_request, init) => {
      inits.push(init)
      return new Response("{}")
    })
    expect(inits).toEqual([undefined])
  })
})
