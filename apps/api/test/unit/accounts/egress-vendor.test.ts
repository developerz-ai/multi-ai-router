import { afterAll, describe, expect, test } from "bun:test"
import { createServer, type Server, type Socket } from "node:net"
import { createProxyProbe, withNeutralControl } from "../../../src/services/accounts/egress/probe"
import { vendorFailure } from "../../../src/services/accounts/egress/vendor"
import { createWebshareVendor } from "../../../src/services/accounts/egress/webshare"
import { KEY, PASSWORD } from "./egress-fixtures"

const row = (id: string) => ({
  id,
  username: "user",
  password: PASSWORD,
  proxy_address: "203.0.113.7",
  port: 6754,
  valid: true,
  last_verification: "2026-11-23T20:00:00Z",
  country_code: "US",
  city_name: "Buffalo",
})

function webshare(
  answer: (page: number, init: RequestInit) => Response | Promise<Response>,
  deps = {},
) {
  const urls: string[] = []
  const vendor = createWebshareVendor({
    apiKey: KEY,
    timeoutMs: 200,
    maxPages: 3,
    maxBytes: 4_096,
    fetch: async (url, init) => {
      urls.push(url)
      return answer(Number(new URL(url).searchParams.get("page")), init)
    },
    ...deps,
  })
  return { vendor, urls }
}

describe("the Webshare listing", () => {
  test("every page is read, from our own page numbers and never from the vendor's link", async () => {
    const { vendor, urls } = webshare((page) =>
      Response.json({
        next: page < 2 ? "https://evil.test/?page=2" : null,
        results: [row(`d-${page}`)],
      }),
    )
    const listing = await vendor.list()
    expect(listing).toMatchObject({ ok: true, complete: true })
    expect(listing.ok && listing.proxies.map((proxy) => proxy.id)).toEqual(["d-1", "d-2"])
    expect(new Set(urls.map((url) => new URL(url).host))).toEqual(new Set(["proxy.webshare.io"]))
  })

  test("the page cap leaves the listing incomplete", async () => {
    const { vendor, urls } = webshare((page) =>
      Response.json({ next: "more", results: [row(`d-${page}`)] }),
    )
    expect(await vendor.list()).toMatchObject({ ok: true, complete: false })
    expect(urls).toHaveLength(3)
  })

  const failures: readonly (readonly [string, () => Response | Promise<Response>, string])[] = [
    ["401", () => new Response(`bad ${KEY}`, { status: 401 }), "unauthorized"],
    ["500", () => new Response(KEY, { status: 500 }), "http_error"],
    ["a rejected fetch", () => Promise.reject(new Error(`failed with ${KEY}`)), "unreachable"],
    ["another shape", () => Response.json({ results: [{ password: PASSWORD }] }), "unreadable"],
    ["a body over the cap", () => new Response("x".repeat(5_000)), "too_large"],
  ]
  for (const [name, answer, code] of failures) {
    test(`${name} is ${code}, and quotes nothing it answered`, async () => {
      const listing = await webshare(answer).vendor.list()
      expect(listing).toMatchObject({ ok: false, code })
      if (listing.ok) return
      const shown = JSON.stringify([listing, vendorFailure("webshare", listing)])
      expect(shown).not.toMatch(/webshare-pw|webshare-api-key/)
    })
  }

  test("a credential that is not well-formed text is an unreadable listing, not a throw", async () => {
    for (const broken of [{ username: "u\ud800" }, { password: "p\udc00" }]) {
      const { vendor } = webshare(() =>
        Response.json({ next: null, results: [{ ...row("d-1"), ...broken }] }),
      )
      expect(await vendor.list()).toEqual({ ok: false, code: "unreadable" })
    }
  })

  test("a vendor that hangs is a timeout, and the deadline covers the whole listing", async () => {
    const { vendor } = webshare(
      (_page, init) =>
        new Promise((_, reject) =>
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    )
    expect(await vendor.list()).toEqual({ ok: false, code: "timeout" })
  })
})

const servers: Server[] = []
afterAll(() => {
  for (const server of servers) server.close()
})

async function proxy(onData: (socket: Socket, head: string) => void): Promise<string> {
  const server = createServer((socket) => {
    socket.on("error", () => {})
    socket.once("data", (data) => onData(socket, data.toString()))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("no port")
  return `http://us%40er:p%3Aw@127.0.0.1:${address.port}`
}

describe("the CONNECT probe", () => {
  const probe = createProxyProbe(250)
  const answers = (head: string) => proxy((socket) => socket.end(head))

  test("asks for the tunnel with the proxy's own credentials and nothing else", async () => {
    let seen = ""
    const url = await proxy((socket, head) => {
      seen = head
      socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
    })
    expect(await probe(url, "openrouter.ai:443")).toMatchObject({ outcome: "ok", status: 200 })
    expect(seen).toBe(
      `CONNECT openrouter.ai:443 HTTP/1.1\r\nHost: openrouter.ai:443\r\nProxy-Authorization: Basic ${Buffer.from("us@er:p:w").toString("base64")}\r\n\r\n`,
    )
  })

  for (const [head, outcome, status] of [
    ["HTTP/1.1 407 Proxy Authentication Required\r\n\r\n", "auth", 407],
    ["HTTP/1.1 402 Payment Required\r\n\r\n", "refused", 402],
    ["HTTP/1.1 502 Bad Gateway\r\n\r\n", "refused", 502],
    ["SSH-2.0-OpenSSH_9.6\r\n", "unreachable", null],
    ["", "unreachable", null],
  ] as const) {
    test(`${JSON.stringify(head)} is ${outcome}`, async () => {
      expect(await probe(await answers(head), "h.test:443")).toMatchObject({ outcome, status })
    })
  }

  test("a proxy that says nothing is a timeout", async () => {
    expect(await probe(await proxy(() => {}), "h.test:443")).toMatchObject({ outcome: "timeout" })
  })

  test("nothing listening is unreachable", async () => {
    expect(await probe("http://127.0.0.1:1", "h.test:443")).toMatchObject({
      outcome: "unreachable",
    })
  })

  test("a live proxy whose tunnel to one host hangs or closes is alive: the host declined it", async () => {
    for (const declined of [(_: Socket) => {}, (socket: Socket) => void socket.destroy()]) {
      const url = await proxy((socket, head) => {
        if (head.startsWith("CONNECT example.com:443")) socket.write("HTTP/1.1 200 OK\r\n\r\n")
        else declined(socket)
      })
      expect(await withNeutralControl(probe)(url, "api.vendor.test:443")).toMatchObject({
        outcome: "refused",
      })
    }
  })

  test("one silent to a neutral host too is dead", async () => {
    expect(
      await withNeutralControl(probe)(await proxy(() => {}), "api.vendor.test:443"),
    ).toMatchObject({ outcome: "timeout" })
  })

  test("a status line split across packets is read whole", async () => {
    const url = await proxy((socket) => {
      socket.write("HTTP/1.1 2")
      setTimeout(() => socket.write("00 OK\r\n\r\n"), 20)
    })
    expect(await probe(url, "h.test:443")).toMatchObject({ outcome: "ok" })
  })
})
