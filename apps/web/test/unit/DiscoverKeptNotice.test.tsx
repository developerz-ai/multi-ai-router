import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { DiscoverKeptNotice } from "../../src/routes/accounts/DiscoverKeptNotice"

/**
 * "Discover models" merges, so an id the catalogue omits is kept and shown here; removing it is one
 * deliberate press that names exactly those ids (prod 2026-11-15: a discovery that replaced the
 * list dropped a hand-added id, and every request for it was refused for 19 h).
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const KEPT = "deepseek/deepseek-v4.1-flash-0925"
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function mount(onRemoved: () => void): () => void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <DiscoverKeptNotice
          accountId="acc-1"
          message="the upstream listed 2 model(s); 1 added to this account's list"
          notInCatalogue={[KEPT]}
          onRemoved={onRemoved}
        />
      </QueryClientProvider>
    ),
    container,
  )
  return () => {
    dispose()
    container.remove()
  }
}

describe("DiscoverKeptNotice", () => {
  test("names the kept ids and sends nothing until pressed", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const unmount = mount(() => {})
    try {
      await settle()
      expect(document.body.textContent).toContain(KEPT)
      expect(calls).toBe(0)
    } finally {
      unmount()
    }
  })

  test("the press removes exactly the kept ids through PATCH /accounts/:id/models", async () => {
    const sent: { method: string; url: string; body: unknown }[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body === undefined ? null : JSON.parse(String(init.body)),
      })
      return new Response(
        JSON.stringify({ accountId: "acc-1", supportedModels: ["a"], added: [], removed: [KEPT] }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch
    let removed = false
    const unmount = mount(() => {
      removed = true
    })
    try {
      const button = [...document.body.querySelectorAll("button")].find(
        (candidate) => candidate.textContent === "Remove these from the account",
      )
      button?.click()
      await settle()
      const patch = sent.find((call) => call.method === "PATCH")
      expect(patch?.url).toContain("/accounts/acc-1/models")
      expect(patch?.body).toEqual({ remove: [KEPT] })
      expect(removed).toBe(true)
    } finally {
      unmount()
    }
  })
})
