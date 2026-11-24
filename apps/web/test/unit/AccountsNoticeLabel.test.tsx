import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import AccountsRoute from "../../src/routes/AccountsRoute"
import { selectOption } from "../support/dom"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const PROVIDER = (id: string) => ({
  id,
  transport: "http",
  authKind: "api-key",
  supportedDialects: ["openai-chat"],
  connectFlow: null,
})
const ROW = {
  id: "acc-1",
  label: "or-main",
  provider: "openrouter",
  status: "active",
  weight: 1,
  priority: 0,
  supportedModels: null,
  hasCredential: true,
  createdAt: "2026-10-03T00:00:00Z",
}

test("a failed row action keeps naming its account when the filter hides it", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if (init?.method === "POST") return new Response("", { status: 409 })
    if (url.includes("/providers"))
      return Response.json({ providers: [PROVIDER("openrouter"), PROVIDER("zai")] })
    if (url.includes("/usage")) return Response.json({ byAccount: [], bucket: "day" })
    if (url.includes("provider=zai")) return Response.json([])
    return Response.json(url.includes("/accounts") ? [ROW] : [])
  }) as typeof fetch
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AccountsRoute />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    const press = [...root.querySelectorAll("button")].find((b) => b.textContent === "Re-check")
    press?.click()
    await settle()
    expect(root.textContent).toContain("Re-check failed: or-main")
    const provider = [...root.querySelectorAll("select")].find((node) =>
      [...node.options].some((option) => option.value === "zai"),
    )
    if (provider === undefined) throw new Error("no provider filter")
    selectOption(provider, "zai")
    await settle()
    expect(root.querySelector('tr[data-row-id="acc-1"]')).toBeNull()
    expect(root.textContent).toContain("Re-check failed: or-main")
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
})
