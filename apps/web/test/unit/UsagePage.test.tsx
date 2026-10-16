import { afterEach, describe, expect, test } from "bun:test"
import { Route, Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import UsageRoute from "../../src/routes/UsageRoute"
import { type WireSummaryOptions, wireReport, wireRow, wireSummary } from "../support/usage-wire"

/**
 * The Usage page as an operator meets it (issue #228): filters that live in the URL, the owner
 * and tool breakdowns, the Unpriced tile and the read-only weekly reports list. Mounted whole
 * against a stubbed `fetch`, so what is proven is the wiring and not just the panels.
 */

const originalFetch = globalThis.fetch
const requests: URL[] = []

afterEach(() => {
  globalThis.fetch = originalFetch
  window.happyDOM.setURL("http://router.test/usage")
  requests.length = 0
})

interface Stub {
  /** The unfiltered summary: also the source of the filter options. */
  readonly summary?: WireSummaryOptions
  /** What a request carrying any filter param answers. Defaults to the same body. */
  readonly filtered?: WireSummaryOptions
  readonly reports?: readonly object[]
}

function stub(options: Stub): void {
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

function mount(path = "/usage") {
  window.happyDOM.setURL(`http://router.test${path}`)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
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

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40))

/** Summary requests only: not the live feed and not the reports list. */
const summaryRequests = () => requests.filter((url) => url.pathname.endsWith("/usage"))

function filterGroup(container: HTMLElement, label: string): HTMLElement {
  const group = Array.from(container.querySelectorAll("details")).find((el) =>
    el.querySelector("summary")?.textContent?.trim().startsWith(label),
  )
  if (!(group instanceof HTMLElement)) throw new Error(`no ${label} filter`)
  return group
}

function option(container: HTMLElement, group: string, value: string): HTMLInputElement {
  const found = Array.from(filterGroup(container, group).querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === value,
  )
  const input = found?.querySelector("input")
  if (!(input instanceof HTMLInputElement)) throw new Error(`no ${value} option under ${group}`)
  return input
}

function dimensionButton(container: HTMLElement, name: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll("button")).find(
    (el) => el.textContent?.trim() === name && el.hasAttribute("aria-pressed"),
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no ${name} dimension`)
  return found
}

const tableRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll("tbody tr")).map((row) => row.textContent ?? "")

const ATTRIBUTION: Stub = {
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

describe("Usage page URL state", () => {
  test("a deep link restores the window and every filter, and the fetch repeats the params", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount(
      "/usage?window=30d&owner=alice&owner=bob&tool=cli&model=claude-x",
    )
    try {
      await settle()
      const filtered = summaryRequests().find((url) => url.searchParams.has("owner"))
      expect(filtered).toBeDefined()
      expect(filtered?.searchParams.get("window")).toBe("30d")
      expect(filtered?.searchParams.getAll("owner")).toEqual(["alice", "bob"])
      expect(filtered?.searchParams.getAll("tool")).toEqual(["cli"])
      expect(filtered?.searchParams.getAll("model")).toEqual(["claude-x"])
      // Repeated, never joined: a comma-joined value would match no owner at all.
      expect(filtered?.search).not.toContain("alice%2Cbob")
      expect(filtered?.search).not.toContain("alice,bob")

      expect(option(container, "Owner", "alice").checked).toBe(true)
      // Absent from the unfiltered options, yet still shown selected so it can be removed.
      expect(option(container, "Owner", "bob").checked).toBe(true)
      expect(option(container, "Tool", "cli").checked).toBe(true)
      const pressed = container.querySelector('button[aria-pressed="true"]')
      expect(container.textContent).toContain("30 days")
      expect(pressed).not.toBeNull()
    } finally {
      dispose()
    }
  })

  test("toggling a filter writes the URL, refetches filtered, and the export carries it", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      expect(summaryRequests().every((url) => !url.searchParams.has("owner"))).toBe(true)

      option(container, "Owner", "alice").click()
      await settle()

      expect(new URLSearchParams(window.location.search).getAll("owner")).toEqual(["alice"])
      const last = summaryRequests().at(-1)
      expect(last?.searchParams.getAll("owner")).toEqual(["alice"])

      const anchor = Array.from(container.querySelectorAll("a")).find(
        (a) => a.textContent?.trim() === "Export CSV",
      )
      const href = new URL(anchor?.getAttribute("href") ?? "", "http://router.test")
      expect(href.searchParams.getAll("owner")).toEqual(["alice"])

      option(container, "Tool", "cli").click()
      await settle()
      expect(summaryRequests().at(-1)?.searchParams.getAll("tool")).toEqual(["cli"])
      expect(summaryRequests().at(-1)?.searchParams.getAll("owner")).toEqual(["alice"])

      option(container, "Owner", "alice").click()
      await settle()
      expect(new URLSearchParams(window.location.search).has("owner")).toBe(false)
    } finally {
      dispose()
    }
  })

  test("owner options are deduped by slug, so a person and a service alice are one option", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      const labels = Array.from(filterGroup(container, "Owner").querySelectorAll("label")).map(
        (el) => el.textContent?.trim(),
      )
      expect(labels.filter((label) => label === "alice")).toHaveLength(1)
      expect(labels).toContain("dana")
      // A bucket is not an owner anyone can filter on.
      expect(labels.some((label) => label?.includes("unassigned"))).toBe(false)
    } finally {
      dispose()
    }
  })
})

describe("Usage page tiles", () => {
  test("Unpriced attempts shows the count", async () => {
    stub({ summary: { totals: { unpricedAttempts: 12 } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const label = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Unpriced attempts",
      )
      expect(label?.nextElementSibling?.textContent).toBe("12")
    } finally {
      dispose()
    }
  })

  test("Unpriced attempts is a dash when the window predates measurement, never 0", async () => {
    stub({ summary: { totals: { unpricedAttempts: null } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const label = Array.from(container.querySelectorAll("span")).find(
        (el) => el.textContent === "Unpriced attempts",
      )
      const tile = label?.parentElement
      expect(label?.nextElementSibling?.textContent).toBe("—")
      expect(tile?.getAttribute("aria-busy")).toBe("false")
    } finally {
      dispose()
    }
  })

  test("token tiles count every prompt token and say how much the cache served", async () => {
    stub({
      summary: { totals: { tokensIn: 600_000, cacheReadTokens: 400_000, tokensOut: 25_000 } },
    })
    const { container, dispose } = mount()
    try {
      await settle()
      const tile = (name: string) =>
        Array.from(container.querySelectorAll("span")).find((el) => el.textContent === name)
          ?.parentElement
      expect(tile("Input tokens")?.textContent).toContain("1M")
      expect(tile("Input tokens")?.textContent).toContain("400k from cache · 40")
      expect(tile("Output tokens")?.textContent).toContain("25k")
    } finally {
      dispose()
    }
  })

  test("no rendered figure adds metered and notional spend", async () => {
    stub({ summary: { totals: { metered: "1.00", notional: "2.00" } } })
    const { container, dispose } = mount()
    try {
      await settle()
      const text = container.textContent ?? ""
      expect(text).toContain("$1.00")
      expect(text).toContain("$2.00")
      expect(text).not.toContain("$3.00")
    } finally {
      dispose()
    }
  })
})

describe("Usage page owner and tool breakdowns", () => {
  test("a person and a service sharing a slug render as two distinguishable rows", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Owner").click()
      await settle()
      const rows = tableRows(container).filter((row) => row.includes("alice"))
      expect(rows).toHaveLength(2)
      expect(rows.some((row) => row.includes("person"))).toBe(true)
      expect(rows.some((row) => row.includes("service"))).toBe(true)
      // A no-kind owner says so rather than passing for a person.
      const dana = tableRows(container).find((row) => row.includes("dana"))
      expect(dana).toContain("unknown")
    } finally {
      dispose()
    }
  })

  test("the unassigned, deleted and none buckets render their own labels", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Owner").click()
      await settle()
      const rows = tableRows(container)
      expect(rows.some((row) => row.includes("(unassigned)"))).toBe(true)
      expect(rows.some((row) => row.includes("(deleted)"))).toBe(true)
      expect(rows.some((row) => row.includes("(none)"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("the tool breakdown renders slugs and the unassigned bucket", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      dimensionButton(container, "Tool").click()
      await settle()
      const rows = tableRows(container)
      expect(rows.some((row) => row.includes("cli"))).toBe(true)
      expect(rows.some((row) => row.includes("(unassigned)"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("a retired key carries a marker and a live one does not", async () => {
    stub(ATTRIBUTION)
    const { container, dispose } = mount()
    try {
      await settle()
      const rows = tableRows(container)
      expect(rows.find((row) => row.includes("old-runner"))).toContain("retired")
      expect(rows.find((row) => row.includes("live-runner"))).not.toContain("retired")
    } finally {
      dispose()
    }
  })
})

describe("Usage page weekly reports", () => {
  test("lists each stored week with its period and delivery status, all four statuses", async () => {
    stub({
      summary: {},
      reports: [
        wireReport("2026-10-05", "2026-10-12", "pending"),
        wireReport("2026-09-28", "2026-10-05", "not_configured"),
        wireReport("2026-09-21", "2026-09-28", "sent", {
          deliveredAt: "2026-09-28T02:00:00.000Z",
        }),
        wireReport("2026-09-14", "2026-09-21", "failed", {
          deliveryAttempts: 3,
          lastError: "secret-looking detail that must not render",
        }),
      ],
    })
    const { container, dispose } = mount()
    try {
      await settle()
      const reports = container.querySelector('[aria-label="Weekly reports"]')
      const text = reports?.textContent ?? ""
      for (const start of ["2026-10-05", "2026-09-28", "2026-09-21", "2026-09-14"]) {
        expect(text).toContain(start)
      }
      for (const status of ["Pending", "Not configured", "Sent", "Failed"]) {
        expect(text).toContain(status)
      }
      // Every row carries the Resend control (#229), and the failure detail stays out of the
      // page: a row names the delivery state, never the webhook error text.
      expect(reports?.querySelectorAll("button")).toHaveLength(4)
      expect(text).not.toContain("secret-looking")
      expect(requests.some((url) => url.pathname.endsWith("/usage/reports"))).toBe(true)
    } finally {
      dispose()
    }
  })

  test("says so when no week has been generated", async () => {
    stub({ summary: {}, reports: [] })
    const { container, dispose } = mount()
    try {
      await settle()
      const reports = container.querySelector('[aria-label="Weekly reports"]')
      expect(reports?.textContent).toContain("No weekly report")
    } finally {
      dispose()
    }
  })
})
