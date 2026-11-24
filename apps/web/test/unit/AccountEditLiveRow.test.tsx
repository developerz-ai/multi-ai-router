import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import { QUERY_DEFAULTS } from "../../src/lib/query"
import AccountsRoute from "../../src/routes/AccountsRoute"
import { fire, typeInto } from "../support/dom"

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

async function editWhile(
  later: readonly string[],
  run: (stage: {
    readonly field: () => HTMLInputElement
    readonly poll: () => Promise<void>
    readonly save: () => Promise<Record<string, unknown> | undefined>
  }) => Promise<void>,
): Promise<void> {
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
    await run({
      field: () => {
        const label = [...document.querySelectorAll("#account-edit-form label")].find((node) =>
          node.textContent?.startsWith("Models it serves"),
        ) as HTMLLabelElement
        return document.getElementById(label.htmlFor) as HTMLInputElement
      },
      poll: async () => {
        models = later
        await client.refetchQueries({ queryKey: ["accounts"] })
        await settle()
      },
      save: async () => {
        const form = document.querySelector("#account-edit-form")
        if (form === null) throw new Error("edit form missing")
        fire(form, "submit")
        await settle()
        expect(patches).toHaveLength(1)
        return patches[0]
      },
    })
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
}

for (const [name, later] of [
  ["discovered", ["a", "b", "c"]],
  ["removed elsewhere", ["a"]],
] as const) {
  test(`a model ${name} while the dialog was open is not in an untouched save`, () =>
    editWhile(later, async ({ poll, save }) => {
      await poll()
      const patch = await save()
      expect(patch).not.toHaveProperty("supportedModels")
      expect(patch).not.toHaveProperty("supportedModelsRemoving")
    }))
}

test("a draft survives the poll, and the save names only the removal the operator made", () =>
  editWhile(["a", "b", "c"], async ({ field, poll, save }) => {
    typeInto(field(), "b")
    await poll()
    expect(field().value).toBe("b")
    const patch = await save()
    expect(patch?.supportedModels).toEqual(["b"])
    expect(patch?.supportedModelsRemoving).toEqual(["a"])
  }))
