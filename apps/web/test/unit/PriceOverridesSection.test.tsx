import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createRoot, createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { PriceOverride, PriceTable } from "../../src/lib/api/settings"
import { PriceOverridesSection } from "../../src/routes/settings/PriceOverridesSection"
import { createPriceState } from "../../src/routes/settings/price-state"
import { fire, selectOption, typeInto } from "../support/dom"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

const RATES = { inputPerMtok: 1, outputPerMtok: 2, cacheReadPerMtok: 0, cacheWritePerMtok: 0 }
const STORED: PriceOverride = {
  provider: "openrouter",
  model: "x",
  ...RATES,
  updatedAt: "2026-01-01T00:00:00Z",
}
const prices = (overrides: readonly PriceOverride[]): PriceTable => ({
  shippedAsOf: "2026-01-01",
  shipped: [{ provider: "zai", model: "glm", ...RATES }],
  overrides,
})

async function withSection(
  overrides: readonly PriceOverride[],
  run: (root: HTMLElement) => Promise<void>,
): Promise<void> {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/providers")
      ? Response.json({ providers: [{ id: "openrouter" }] })
      : Response.json({ prices: prices(overrides) })) as typeof fetch
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <PriceOverridesSection />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    await run(root)
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
}

const button = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((node) => node.textContent === label)

test("re-adding a removed override lists it once", async () => {
  await withSection([STORED], async (root) => {
    button(root, "Remove")?.click()
    const select = [...root.querySelectorAll("select")].find((node) =>
      [...node.options].some((option) => option.value === "openrouter"),
    )
    const model = [...root.querySelectorAll<HTMLInputElement>("input[required]")].at(-1)
    const form = button(root, "Add model")?.closest("form")
    if (select === undefined || model === undefined || !form) throw new Error("add form missing")
    selectOption(select, "openrouter")
    typeInto(model, "x")
    fire(form, "submit")
    const ids = [...root.querySelectorAll("tr[data-row-id]")].map((row) =>
      row.getAttribute("data-row-id"),
    )
    expect(ids).toEqual(["openrouter:x", "zai:glm"])
  })
})

test("a cleared rate can be discarded, as the message says", async () => {
  await withSection([], async (root) => {
    const rate = root.querySelector<HTMLInputElement>('input[aria-label^="Input rate"]')
    if (rate === null) throw new Error("rate input missing")
    typeInto(rate, "")
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("discard")
    button(root, "Discard changes")?.click()
    expect(root.querySelector('[role="alert"]')).toBeNull()
    expect(rate.value).toBe("1")
  })
})

test("rows are derived once per change, not once per reader", () => {
  createRoot((dispose) => {
    const [table] = createSignal(prices([STORED]))
    const state = createPriceState(table)
    const first = state.rows()
    const diff = state.diff()
    expect(state.rows() === first).toBe(true)
    expect(state.diff() === diff).toBe(true)
    const target = first[0]
    if (target === undefined) throw new Error("no rows")
    state.edit(target, "inputPerMtok", "9")
    expect(state.rows() === first).toBe(false)
    dispose()
  })
})
