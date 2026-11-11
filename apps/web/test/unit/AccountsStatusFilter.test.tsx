import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import AccountsRoute from "../../src/routes/AccountsRoute"
import { selectOption } from "../support/dom"

/**
 * "Cooling down" is a live state: the server overlays it onto the stored status when it answers
 * the list. Sent as `?status=`, the API filtered its stored column before that overlay and the
 * filter matched nothing. The console now filters on the status each row actually carries.
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function account(id: string, status: AccountView["status"]): AccountView {
  return {
    id,
    label: `label-${id}`,
    provider: "zai",
    status,
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 0,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-10-03T00:00:00Z",
    updatedAt: "2026-10-03T00:00:00Z",
  }
}

test("the status filter keeps a live cooling_down row and never sends ?status=", async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    urls.push(url)
    let body: unknown = []
    if (url.includes("/usage")) body = { byAccount: [], byKey: [], byModel: [], bucket: "day" }
    else if (url.includes("/accounts"))
      body = [account("hot", "cooling_down"), account("fine", "active")]
    return Response.json(body)
  }) as typeof fetch

  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AccountsRoute />
      </QueryClientProvider>
    ),
    container,
  )
  try {
    await settle()
    const select = container.querySelector("select")
    if (select === null) throw new Error("status select missing")
    selectOption(select, "cooling_down")
    await settle()

    expect(container.querySelector('tr[data-row-id="hot"]')).not.toBeNull()
    expect(container.querySelector('tr[data-row-id="fine"]')).toBeNull()
    expect(urls.filter((url) => url.includes("/accounts") && url.includes("status="))).toEqual([])
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
})
