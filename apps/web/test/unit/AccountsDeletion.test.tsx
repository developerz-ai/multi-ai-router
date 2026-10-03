import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import AccountsRoute from "../../src/routes/AccountsRoute"

const originalFetch = globalThis.fetch
const account: AccountView = {
  id: "fixture-account",
  label: "Claude fixture",
  provider: "anthropic-oauth",
  status: "active",
  hasCredential: false,
  configDir: "/private/credential-directory",
  baseUrl: null,
  dialect: null,
  modelAliases: null,
  supportedModels: null,
  windowTokenLimits: null,
  weight: 1,
  priority: 0,
  billing: "subscription",
  tokenExpiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
}
afterEach(() => {
  globalThis.fetch = originalFetch
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll("button")].find(
    (node) => node.textContent?.trim() === label,
  )
  if (!found) throw new Error(`button missing: ${label}`)
  return found
}

for (const cleanup of ["deferred", "removed", "not_applicable"] as const) {
  test(`actual account deletion screen reports ${cleanup} cleanup without reviving the deleted row`, async () => {
    let deleted = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      let body: unknown = []
      if (init?.method === "DELETE") {
        deleted = true
        body = { id: account.id, deleted: true, cleanup }
      } else if (url.includes("/providers"))
        body = {
          providers: [
            {
              id: "anthropic-oauth",
              transport: "agent-sdk",
              authKind: "oauth",
              nativeDialect: "anthropic",
              supportedDialects: ["anthropic"],
              requiresBaseUrl: false,
              requiresConfigDir: true,
              connectFlow: "cli",
              creatable: true,
              reason: null,
            },
          ],
        }
      else if (url.includes("/usage"))
        body = { byAccount: [], byKey: [], byModel: [], bucket: "day" }
      else if (url.includes("/accounts")) body = deleted ? [] : [account]
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
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
      button("Delete").click()
      await settle()
      button("Delete account").click()
      await settle()
      expect(deleted).toBe(true)
      expect(document.body.textContent).not.toContain("Delete this account?")
      if (cleanup === "deferred") {
        expect(document.body.textContent).toContain("Account deleted; credential cleanup deferred")
        expect(document.body.textContent).toContain("no longer available for routing")
        expect(document.body.textContent).toContain("operator follow-up")
        expect(document.body.textContent).not.toContain(account.configDir ?? "missing")
        button("Dismiss").click()
        expect(document.body.textContent).not.toContain("credential cleanup deferred")
      } else expect(document.body.textContent).not.toContain("credential cleanup deferred")
    } finally {
      dispose()
      client.clear()
      container.remove()
    }
  })
}
