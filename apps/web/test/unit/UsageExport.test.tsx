import { afterEach, describe, expect, test } from "bun:test"
import { Router } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { usageExportHref, usageQueryParams } from "../../src/lib/api/usage-params"
import UsageRoute from "../../src/routes/UsageRoute"
import { UsageExport } from "../../src/routes/usage/UsageExport"

/**
 * The Export CSV control (issue #226). Its href is built from the same params object the summary
 * query sends, so a window the operator picked is the window the file covers; any filter params
 * present are forwarded (the filter bar of the follow-up issue lands on this).
 */
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const search = (href: string) => new URL(href, "http://router.test").searchParams

describe("usageQueryParams / usageExportHref", () => {
  test("a named window is sent as window=", () => {
    expect(usageQueryParams("7d")).toEqual({ window: "7d" })
    const href = usageExportHref("30d")
    expect(href.startsWith("/api/admin/usage/export.csv?")).toBe(true)
    expect(search(href).get("window")).toBe("30d")
  })

  test("a custom range carries from and to, and no window", () => {
    const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T12:30:00.000Z" }
    expect(usageQueryParams(range)).toEqual(range)
    const params = search(usageExportHref(range))
    expect(params.get("from")).toBe(range.from)
    expect(params.get("to")).toBe(range.to)
    expect(params.has("window")).toBe(false)
  })

  test("filter params present are forwarded, repeated values kept", () => {
    const params = search(usageExportHref("today", { owner: ["alice", "bob"], model: ["m1"] }))
    expect(params.getAll("owner")).toEqual(["alice", "bob"])
    expect(params.getAll("model")).toEqual(["m1"])
    expect(params.get("window")).toBe("today")
  })

  test("an empty filter list sends nothing", () => {
    const params = search(usageExportHref("today", { owner: [] }))
    expect(params.has("owner")).toBe(false)
  })
})

describe("UsageRoute export control", () => {
  function mount() {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString()
      const body = url.includes("/usage/recent") ? { attempts: [], limit: 50 } : []
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch
    const container = document.createElement("div")
    document.body.appendChild(container)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const dispose = render(
      () => (
        <QueryClientProvider client={client}>
          <UsageRoute />
        </QueryClientProvider>
      ),
      container,
    )
    return { container, dispose }
  }
  const link = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("a")).find((a) => a.textContent?.trim() === "Export CSV")

  test("links to the export for the selected window", async () => {
    const { container, dispose } = mount()
    try {
      const anchor = link(container)
      expect(anchor).toBeDefined()
      expect(search(anchor?.getAttribute("href") ?? "").get("window")).toBe("7d")
      const buttons = Array.from(container.querySelectorAll("button"))
      buttons.find((b) => b.textContent?.trim() === "30 days")?.click()
      expect(search(link(container)?.getAttribute("href") ?? "").get("window")).toBe("30d")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("after a custom range is applied the href carries from and to", async () => {
    const { container, dispose } = mount()
    try {
      const [from, to] = Array.from(container.querySelectorAll("input[type=datetime-local]"))
      if (!(from instanceof HTMLInputElement) || !(to instanceof HTMLInputElement))
        throw new Error("custom range inputs missing")
      from.value = "2026-10-01T00:00"
      from.dispatchEvent(new InputEvent("input", { bubbles: true }))
      to.value = "2026-10-08T00:00"
      to.dispatchEvent(new InputEvent("input", { bubbles: true }))
      container
        .querySelector("form")
        ?.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true }))
      const params = search(link(container)?.getAttribute("href") ?? "")
      expect(params.has("window")).toBe(false)
      expect(Date.parse(params.get("from") ?? "")).toBe(Date.parse("2026-10-01T00:00"))
      expect(Date.parse(params.get("to") ?? "")).toBe(Date.parse("2026-10-08T00:00"))
    } finally {
      dispose()
      container.remove()
    }
  })
})

describe("UsageExport inside the router", () => {
  test("a primary click is left to the browser: the SPA router must not intercept the download", () => {
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <Router>
          <UsageExport filters={{}} range="7d" />
        </Router>
      ),
      container,
    )
    try {
      const anchor = container.querySelector("a")
      if (anchor === null) throw new Error("export link missing")
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })
      anchor.dispatchEvent(click)
      // @solidjs/router's document click handler preventDefaults any same-origin anchor it does
      // not recognise as external, and then navigates the SPA to a route that does not exist.
      expect(click.defaultPrevented).toBe(false)
      expect(anchor.getAttribute("rel")).toBe("external")
    } finally {
      dispose()
      container.remove()
    }
  })
})
