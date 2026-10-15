import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import KeysRoute from "../../src/routes/KeysRoute"
import { fire, typeInto } from "../support/dom"
import { usageCoverage } from "../support/usage-coverage"

const PLAINTEXT = "mar_live_9f2c4d6e8a0b2c4d6e8a0b2c"
const KEY_ID = "44444444-4444-4444-8444-444444444444"

/**
 * The screen that hands out live credentials, mounted whole against a stubbed
 * `fetch` — the only web test that drives a route rather than a component,
 * because the behaviour asserted here is wiring between a dialog and the query
 * client and neither half shows it alone.
 *
 * What it guards: **a revealed or minted value is gone from the client once its
 * dialog closes.** Keys are retrievable by design (non-negotiable 5), so this is
 * not a shown-once flow — it is that a plaintext credential should not outlive
 * the dialog showing it, sitting in TanStack's mutation cache for the life of
 * the tab where anything reaching the client can read it back.
 */

const originalFetch = globalThis.fetch

/** When set, the keys list answers with these rows instead of the two defaults. */
let listOverride: unknown[] | null = null

afterEach(() => {
  globalThis.fetch = originalFetch
  listOverride = null
})

interface Mounted {
  readonly client: QueryClient
  readonly dispose: () => void
  readonly container: HTMLElement
}

/** Every plaintext the query client is holding anywhere, query or mutation cache. */
function cachedState(client: QueryClient): string {
  return JSON.stringify([
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  ])
}

function stubFetch(calls: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url}`)
    return new Response(JSON.stringify(responseFor(method, url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** The three responses this screen needs, plus empty lists for everything else. */
function responseFor(method: string, url: string): unknown {
  if (url.endsWith("/reveal")) return { ...keyRow(), value: PLAINTEXT }
  if (url.endsWith("/keys"))
    return method === "POST"
      ? { ...attributedRow(), value: PLAINTEXT }
      : (listOverride ?? [keyRow(), attributedRow()])
  if (url.includes("/settings")) return { publicUrl: "https://router.example.com" }
  if (url.includes("/usage")) return usageSummary()
  return []
}

function mount(): Mounted {
  const container = document.createElement("div")
  document.body.appendChild(container)
  // No retries: a stubbed response that does not parse should fail the test, not
  // be quietly attempted three more times.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <KeysRoute />
      </QueryClientProvider>
    ),
    container,
  )
  return { client, dispose, container }
}

/** Solid renders synchronously; what is awaited here is the stubbed round trip. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function buttonLabelled(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (button) => button.textContent?.trim() === label,
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button labelled "${label}"`)
  return found
}

/** Control ids are generated, so a field is found the way an operator does: by its label. */
function fieldLabelled(text: string): HTMLInputElement {
  const label = Array.from(document.body.querySelectorAll("label")).find((element) =>
    element.textContent?.trim().startsWith(text),
  )
  const input = label === undefined ? null : document.getElementById(label.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled "${text}"`)
  return input
}

describe("KeysRoute", () => {
  test("drops a revealed value from the query client when its dialog closes", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()

      buttonLabelled("Reveal").click()
      await settle()

      expect(calls).toContain(`POST /api/admin/keys/${KEY_ID}/reveal`)
      expect(document.body.textContent).toContain(PLAINTEXT)
      // The value is genuinely in the client at this point — otherwise the
      // assertion after the close would pass against a cache that never held it.
      expect(cachedState(client)).toContain(PLAINTEXT)

      buttonLabelled("Done").click()
      await settle()

      expect(document.body.textContent).not.toContain(PLAINTEXT)
      expect(cachedState(client)).not.toContain(PLAINTEXT)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("a second reveal still works after the first was dropped", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()
      buttonLabelled("Reveal").click()
      await settle()
      buttonLabelled("Done").click()
      await settle()

      buttonLabelled("Reveal").click()
      await settle()

      expect(document.body.textContent).toContain(PLAINTEXT)
      expect(calls.filter((call) => call.endsWith("/reveal"))).toHaveLength(2)

      buttonLabelled("Done").click()
      await settle()
      expect(cachedState(client)).not.toContain(PLAINTEXT)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("drops a freshly minted value too — the mint response carries one as well", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()

      buttonLabelled("Mint key").click()
      typeInto(fieldLabelled("Name"), "ci-runner")
      const form = document.body.querySelector("form")
      if (form === null) throw new Error("mint form not rendered")
      fire(form, "submit")
      await settle()

      expect(calls).toContain("POST /api/admin/keys")
      expect(document.body.textContent).toContain(PLAINTEXT)
      expect(cachedState(client)).toContain(PLAINTEXT)

      buttonLabelled("Done").click()
      await settle()

      expect(document.body.textContent).not.toContain(PLAINTEXT)
      expect(cachedState(client)).not.toContain(PLAINTEXT)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("owner and tool chips narrow the table without another fetch", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { dispose, container } = mount()
    try {
      await settle()
      expect(container.textContent).toContain("ci-runner")
      expect(container.textContent).toContain("nightly-runner")

      buttonLabelled("ci-team").click()
      await settle()

      expect(container.textContent).not.toContain("ci-runner")
      expect(container.textContent).toContain("nightly-runner")
      // Narrowing is local to the loaded list: the chips need every owner and
      // tool in hand, so a filtered refetch would starve its own vocabulary.
      expect(calls.filter((call) => call === "GET /api/admin/keys")).toHaveLength(1)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("a selected owner whose last key is relabelled stops filtering — rows come back", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()
      buttonLabelled("ci-team").click()
      await settle()
      expect(container.textContent).not.toContain("ci-runner")

      // The only ci-team key is relabelled away; the chip leaves with it.
      listOverride = [keyRow(), { ...attributedRow(), owner: "someone-else" }]
      await client.invalidateQueries()
      await settle()

      expect(container.textContent).toContain("ci-runner")
      expect(container.textContent).toContain("nightly-runner")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("a dead owner selection is cleared, so it cannot resurrect when the owner returns", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()
      buttonLabelled("ci-team").click()
      await settle()
      expect(container.textContent).not.toContain("ci-runner")

      listOverride = [keyRow(), { ...attributedRow(), owner: "someone-else" }]
      await client.invalidateQueries()
      await settle()

      listOverride = [keyRow(), attributedRow()]
      await client.invalidateQueries()
      await settle()

      expect(container.textContent).toContain("ci-runner")
      expect(container.textContent).toContain("nightly-runner")
      expect(buttonLabelled("ci-team").getAttribute("aria-pressed")).toBe("false")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("a selection survives no emptied list: the owner's return does not re-apply it", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { client, dispose, container } = mount()
    try {
      await settle()
      buttonLabelled("ci-team").click()
      await settle()

      listOverride = []
      await client.invalidateQueries()
      await settle()

      listOverride = [keyRow(), attributedRow()]
      await client.invalidateQueries()
      await settle()

      expect(container.textContent).toContain("ci-runner")
      expect(container.textContent).toContain("nightly-runner")
      expect(buttonLabelled("ci-team").getAttribute("aria-pressed")).toBe("false")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("a combination that matches nothing offers Clear filters", async () => {
    const calls: string[] = []
    stubFetch(calls)
    listOverride = [
      { ...attributedRow(), id: "a", name: "k-a", owner: "ci-team", tool: "aider" },
      { ...attributedRow(), id: "b", name: "k-b", owner: "marta", tool: "claude-code" },
    ]
    const { dispose, container } = mount()
    try {
      await settle()
      buttonLabelled("ci-team").click()
      buttonLabelled("claude-code").click()
      await settle()
      expect(container.textContent).not.toContain("k-a")
      expect(container.textContent).toContain("Clear filters")

      buttonLabelled("Clear filters").click()
      await settle()
      expect(container.textContent).toContain("k-a")
      expect(container.textContent).toContain("k-b")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("mints a successor from a row: prefilled, unnamed, a POST — never a PATCH", async () => {
    const calls: string[] = []
    stubFetch(calls)
    const { dispose, container } = mount()
    try {
      await settle()

      const successors = Array.from(document.body.querySelectorAll("button")).filter(
        (button) => button.textContent?.trim() === "Mint successor",
      )
      expect(successors.length).toBe(2)
      const attributed = successors[1]
      if (!(attributed instanceof HTMLButtonElement)) throw new Error("no successor button")
      attributed.click()
      await settle()

      const form = document.body.querySelector("form")
      if (form === null) throw new Error("mint form not rendered")
      expect(fieldLabelled("Name").value).toBe("")
      expect(fieldLabelled("Owner").value).toBe("ci-team")
      expect(fieldLabelled("Requests").value).toBe("120")

      fire(form, "submit")
      await settle()

      expect(calls).toContain("POST /api/admin/keys")
      expect(calls.filter((call) => call.startsWith("PATCH"))).toHaveLength(0)
    } finally {
      dispose()
      container.remove()
    }
  })
})

function keyRow() {
  return {
    id: KEY_ID,
    name: "ci-runner",
    prefix: "mar_live_9f2c",
    owner: null,
    ownerKind: null,
    tool: null,
    purpose: null,
    scope: { kind: "all", poolIds: [], accountIds: [] },
    rateLimit: null,
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  }
}

/** The second row carries attribution, so the chips and the successor action have something to read. */
function attributedRow() {
  return {
    ...keyRow(),
    id: "55555555-5555-4555-8555-555555555555",
    name: "nightly-runner",
    prefix: "mar_live_5555",
    owner: "ci-team",
    ownerKind: "service",
    tool: "claude-code",
    purpose: "nightly builds",
    rateLimit: { requests: 120, windowSeconds: 300 },
  }
}

function usageSummary() {
  const totals = {
    requests: 0,
    attempts: 0,
    errors: 0,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: "0",
    costNotional: "0",
  }
  return {
    window: "7d",
    bucket: "day",
    from: "2026-07-18T00:00:00.000Z",
    to: "2026-07-25T00:00:00.000Z",
    totals,
    coverage: usageCoverage(0),
    latency: { p50Ms: null, p95Ms: null, routerOverheadP95Ms: null, ttfbP95Ms: null },
    failures: { attempts: 0, errors: 0, partial: false, byOutcome: [] },
    axis: [],
    series: [],
    byKey: [],
    byAccount: [],
    byPool: [],
    byModel: [],
  }
}
