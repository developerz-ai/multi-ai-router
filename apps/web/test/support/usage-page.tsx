import { Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import UsageRoute from "../../src/routes/UsageRoute"
import { type WireSummaryOptions, wireRow, wireSummary } from "./usage-wire"

/**
 * The mount harness the Usage page tests share: a stubbed `fetch` answering the admin API's
 * usage endpoints, and the whole route mounted against it — what is proven is the wiring and
 * not just the panels. Each test file registers {@link resetUsagePage} in its own `afterEach`.
 */

const originalFetch = globalThis.fetch
export const requests: URL[] = []

export function resetUsagePage(): void {
  globalThis.fetch = originalFetch
  window.happyDOM.setURL("http://router.test/usage")
  requests.length = 0
}

export interface Stub {
  /** The unfiltered summary: also the source of the filter options. */
  readonly summary?: WireSummaryOptions
  /** What a request carrying any filter param answers. Defaults to the same body. */
  readonly filtered?: WireSummaryOptions
  readonly reports?: readonly object[]
}

export function stub(options: Stub): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://router.test")
    requests.push(url)
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    if (url.pathname.endsWith("/usage/recent")) return json({ attempts: [], limit: 50 })
    if (url.pathname.endsWith("/usage/reports")) return json({ reports: options.reports ?? [] })
    if (url.pathname.endsWith("/usage")) {
      const filtered = ["owner", "tool", "model"].some((name) => url.searchParams.has(name))
      return json(wireSummary(filtered ? (options.filtered ?? options.summary) : options.summary))
    }
    return json([])
  }) as typeof fetch
}

export function mount(path = "/usage") {
  window.happyDOM.setURL(`http://router.test${path}`)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <Router>
          <Route path="*" component={UsageRoute} />
        </Router>
      </QueryClientProvider>
    ),
    container,
  )
  return {
    container,
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

/** Summary requests only: not the live feed and not the reports list. */
export const summaryRequests = () => requests.filter((url) => url.pathname.endsWith("/usage"))

export function filterGroup(container: HTMLElement, label: string): HTMLElement {
  const group = Array.from(container.querySelectorAll("details")).find((el) =>
    el.querySelector("summary")?.textContent?.trim().startsWith(label),
  )
  if (!(group instanceof HTMLElement)) throw new Error(`no ${label} filter`)
  return group
}

export function option(container: HTMLElement, group: string, value: string): HTMLInputElement {
  const found = Array.from(filterGroup(container, group).querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === value,
  )
  const input = found?.querySelector("input")
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${value} option under ${group}`)
  return input
}

export function dimensionButton(container: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === name && el.hasAttribute("aria-pressed"),
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${name} dimension`)
  return found
}

export const tableRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "")

export const ATTRIBUTION: Stub = {
  summary: {
    byOwner: [
      wireRow("person/alice", "alice", null, { ownerKind: "person" }, { requests: 5 }),
      wireRow("service/alice", "alice", null, { ownerKind: "service" }, { requests: 4 }),
      wireRow("unknown/dana", "dana", null, { ownerKind: null }, { requests: 3 }),
      wireRow(null, null, "unassigned", { ownerKind: null }, { requests: 2 }),
      wireRow(null, null, "deleted", { ownerKind: null }, { requests: 1 }),
      wireRow(null, null, "none", { ownerKind: null }, { requests: 1 }),
    ],
    byTool: [
      wireRow("cli", "cli", null, {}, { requests: 7 }),
      wireRow(null, null, "unassigned", {}, { requests: 3 }),
    ],
    byModel: [wireRow("m-1", "claude-x", null, {}, { requests: 9 })],
    byKey: [
      wireRow("k1", "old-runner", null, { retired: true }),
      wireRow("k2", "live-runner", null, { retired: false }),
    ],
  },
}
