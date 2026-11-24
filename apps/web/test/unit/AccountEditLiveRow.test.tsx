import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import { QUERY_DEFAULTS } from "../../src/lib/query"
import AccountsRoute from "../../src/routes/AccountsRoute"
import { fire } from "../support/dom"

/**
 * The dialog edits a *live* row: the table hands out a proxy that follows every poll. Diffing the
 * model list against that row named ids discovered while the dialog was open as deliberate
 * removals, which is exactly the write the API's replace guard refuses (prod 2026-11-15).
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const PROVIDER = {
  id: "openrouter",
  transport: "http",
  authKind: "api-key",
  nativeDialect: "openai-chat",
  supportedDialects: ["openai-chat"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
  defaultBilling: "metered",
  billingFixed: true,
}

const account = (supportedModels: readonly string[]) => ({
  id: "acc-1",
  label: "or-main",
  provider: "openrouter",
  status: "active",
  hasCredential: true,
  configDir: null,
  baseUrl: null,
  dialect: null,
  modelAliases: null,
  supportedModels,
  windowTokenLimits: null,
  weight: 1,
  priority: 0,
  billing: "metered",
  tokenExpiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-03T00:00:00Z",
  updatedAt: "2026-10-03T00:00:00Z",
})

for (const [name, later] of [
  ["discovered", ["a", "b", "c"]],
  ["removed elsewhere", ["a"]],
] as const) {
  test(`a model ${name} while the dialog was open is not in an untouched save`, async () => {
    let models: readonly string[] = ["a", "b"]
    const patches: Record<string, unknown>[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)))
        return Response.json(account(models))
      }
      if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
      if (url.includes("/providers")) return Response.json({ providers: [PROVIDER] })
      if (url.includes("/usage")) return Response.json({ byAccount: [], bucket: "day" })
      if (url.includes("/accounts")) return Response.json([account(models)])
      return Response.json([])
    }) as typeof fetch

    const container = document.createElement("div")
    document.body.appendChild(container)
    const client = new QueryClient({
      defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false } },
    })
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
      const edit = [...container.querySelectorAll("button")].find((b) => b.textContent === "Edit")
      edit?.click()
      await settle()
      models = later
      await client.refetchQueries({ queryKey: ["accounts"] })
      await settle()

      const form = document.querySelector("#account-edit-form")
      if (form === null) throw new Error("edit form missing")
      fire(form, "submit")
      await settle()

      expect(patches).toHaveLength(1)
      expect(patches[0]).not.toHaveProperty("supportedModels")
      expect(patches[0]).not.toHaveProperty("supportedModelsRemoving")
    } finally {
      dispose()
      client.clear()
      container.remove()
    }
  })
}
