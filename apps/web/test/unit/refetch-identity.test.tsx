import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal, type JSX } from "solid-js"
import { render } from "solid-js/web"
import { Table } from "../../src/components/Table"
import type { AccountView } from "../../src/lib/api/types"
import type { RecentAttempt } from "../../src/lib/api/usage-recent"
import { QUERY_DEFAULTS } from "../../src/lib/query"
import AccountsRoute from "../../src/routes/AccountsRoute"
import { UsageRecent } from "../../src/routes/usage/UsageRecent"
import { typeInto } from "../support/dom"

/**
 * A poll that brings back the same rows must not rebuild the screen.
 *
 * `/accounts` refetches every 20 s and the live feed every 10 s. Before the fix each refetch
 * handed the screen brand-new objects, the boundary re-ran its render callback, and every row,
 * group and input under it was disposed and recreated: a collapsed provider group re-opened, a
 * half-typed Test-now model was wiped, focus dropped to `<body>`. These tests mount the real
 * routes against the console's own query defaults and assert DOM node identity across a refetch.
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

function account(id: string, label: string): AccountView {
  return {
    id,
    label,
    provider: "anthropic-api",
    status: "active",
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

const PROVIDER = {
  id: "anthropic-api",
  transport: "http",
  authKind: "api-key",
  nativeDialect: "anthropic",
  supportedDialects: ["anthropic"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
}

function stubFetch(answer: (url: string) => unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    return new Response(JSON.stringify(answer(url)), {
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

async function mount(
  view: () => JSX.Element,
  run: (client: QueryClient, container: HTMLElement) => Promise<void>,
): Promise<void> {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { ...QUERY_DEFAULTS } } })
  const dispose = render(
    () => <QueryClientProvider client={client}>{view()}</QueryClientProvider>,
    container,
  )
  try {
    await settle()
    await run(client, container)
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
}

/** Identity, not equality — and no 10k-line DOM dump when it fails. */
function expectSameNode(actual: Node | null, expected: Node): void {
  expect(actual === expected ? "same node" : "replaced").toBe("same node")
}

function rowNode(container: HTMLElement, id: string): HTMLTableRowElement {
  const row = container.querySelector<HTMLTableRowElement>(`tr[data-row-id="${id}"]`)
  if (row === null) throw new Error(`row missing: ${id}`)
  return row
}

test("an identical accounts poll keeps a collapsed group, a typed model and every row node", async () => {
  let rows = [account("acc-1", "claude-one"), account("acc-2", "claude-two")]
  stubFetch((url) => {
    if (url.includes("/providers")) return { providers: [PROVIDER] }
    if (url.includes("/usage")) return { byAccount: [], byKey: [], byModel: [], bucket: "day" }
    if (url.includes("/pools")) return []
    if (url.includes("/accounts")) return rows
    return []
  })

  await mount(
    () => <AccountsRoute />,
    async (client, container) => {
      const toggle = container.querySelector<HTMLButtonElement>("button[aria-expanded]")
      if (toggle === null) throw new Error("group toggle missing")
      toggle.click()
      expect(toggle.getAttribute("aria-expanded")).toBe("false")

      const firstRow = rowNode(container, "acc-1")
      const secondRow = rowNode(container, "acc-2")
      const modelInput = firstRow.querySelector<HTMLInputElement>('input[placeholder="model name"]')
      if (modelInput === null) throw new Error("model input missing")
      typeInto(modelInput, "claude-x")

      // What `LIVE_POLL_MS` does: the same body again, parsed into fresh objects.
      await client.refetchQueries({ queryKey: ["accounts"] })
      await settle()

      const toggleAfter = container.querySelector<HTMLButtonElement>("button[aria-expanded]")
      expectSameNode(toggleAfter, toggle)
      expect(toggle.getAttribute("aria-expanded")).toBe("false")
      expectSameNode(rowNode(container, "acc-1"), firstRow)
      expectSameNode(rowNode(container, "acc-2"), secondRow)
      expect(modelInput.isConnected).toBe(true)
      expect(modelInput.value).toBe("claude-x")

      // A changed row updates its own text in place; its sibling is untouched.
      rows = [{ ...account("acc-1", "claude-one-renamed") }, account("acc-2", "claude-two")]
      await client.refetchQueries({ queryKey: ["accounts"] })
      await settle()

      expectSameNode(rowNode(container, "acc-1"), firstRow)
      expect(firstRow.textContent).toContain("claude-one-renamed")
      expectSameNode(rowNode(container, "acc-2"), secondRow)
      expect(modelInput.value).toBe("claude-x")
    },
  )
})

function attempt(id: string, model: string): RecentAttempt {
  return {
    id,
    correlationId: `corr-${id}`,
    clientRequestId: null,
    attempt: 1,
    key: { id: "key-1", label: "dev-laptops", note: null },
    account: { id: "acct-1", label: "claude-one", note: null },
    pool: { id: null, label: null, note: "none" },
    provider: "anthropic-api",
    model,
    upstreamModel: model,
    ingressDialect: "anthropic",
    egressMode: "passthrough",
    outcome: "success",
    fault: "none",
    httpStatus: 200,
    responseStatus: 200,
    errorClass: null,
    latencyMs: 10,
    ttfbMs: 5,
    routerOverheadMs: 1,
    streamed: false,
    tokensIn: 1,
    tokensOut: 1,
    at: "2026-10-03T00:00:00Z",
  }
}

test("an identical live-feed poll keeps every row node", async () => {
  const attempts = [attempt("u-1", "model-a"), attempt("u-2", "model-b")]
  stubFetch(() => ({ attempts, limit: 50 }))

  await mount(
    () => <UsageRecent />,
    async (client, container) => {
      const first = rowNode(container, "u-1")
      const second = rowNode(container, "u-2")

      await client.refetchQueries({ queryKey: ["usage"] })
      await settle()

      expectSameNode(rowNode(container, "u-1"), first)
      expectSameNode(rowNode(container, "u-2"), second)
    },
  )
})

test("a table handed fresh objects for the same ids keeps each row and its input (price editor keystroke)", () => {
  interface Row {
    readonly id: string
    readonly label: string
  }
  const [rows, setRows] = createSignal<readonly Row[]>([
    { id: "a", label: "first" },
    { id: "b", label: "second" },
  ])
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <Table
        columns={[
          { id: "label", header: "Label", cell: (row: Row) => row.label },
          { id: "edit", header: "Edit", cell: (row: Row) => <input aria-label={row.label} /> },
        ]}
        rowId={(row) => row.id}
        rows={rows()}
      />
    ),
    container,
  )
  try {
    const first = rowNode(container, "a")
    const input = first.querySelector("input")
    if (input === null) throw new Error("input missing")
    input.value = "half-typed"

    // What `PriceOverridesSection` does per keystroke: every row re-derived into a new object.
    setRows([
      { id: "a", label: "first edited" },
      { id: "b", label: "second" },
    ])

    expectSameNode(rowNode(container, "a"), first)
    expectSameNode(first.querySelector("input"), input)
    expect(input.value).toBe("half-typed")
    expect(input.getAttribute("aria-label")).toBe("first edited")
    expect(first.textContent).toContain("first edited")

    setRows([{ id: "b", label: "second" }])
    expect(container.querySelector('tr[data-row-id="a"]')).toBeNull()
  } finally {
    dispose()
    container.remove()
  }
})
