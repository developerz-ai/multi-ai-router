import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import OverviewRoute from "../../src/routes/OverviewRoute"

/**
 * The dashboard mounted whole against a stubbed `fetch`.
 *
 * The one thing this proves is the gap the task closed: Overview used to hardcode `window: "7d"`
 * on `GET /api/admin/usage` (well, `"today"`, but the shape of the bug is the same) with no
 * control anywhere on the screen, so its headline figures and the Usage screen's could disagree
 * with no way to tell why. A component test that only renders the button and checks
 * `aria-pressed` would not catch a wiring bug where the click updates the pressed state but not
 * the query — so this asserts the actual outgoing request changes.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const usageRequests: string[] = []

/** What `GET /accounts` answers with — each test sets its own fleet before mounting. */
let accountRows: readonly unknown[] = []

function stubFetch(accounts: readonly unknown[] = [account()]): void {
  usageRequests.length = 0
  accountRows = accounts
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    return new Response(JSON.stringify(responseFor(url)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

function responseFor(url: string): unknown {
  if (url.includes("/usage")) {
    usageRequests.push(url)
    return usageSummary()
  }
  if (url.includes("/accounts")) return accountRows
  if (url.includes("/pools")) return []
  if (url.includes("/keys")) return []
  if (url.includes("/providers")) return { providers: [] }
  if (url.includes("/settings")) return { publicUrl: null, retentionDays: 30, logLevel: "info" }
  return []
}

function mount(): { readonly dispose: () => void; readonly container: HTMLElement } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <OverviewRoute />
      </QueryClientProvider>
    ),
    container,
  )
  return { dispose, container }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe("OverviewRoute", () => {
  test("has a window control, and switching it re-queries usage for the new window", async () => {
    stubFetch()
    const { dispose, container } = mount()
    try {
      await settle()

      // Defaults to "today" — same window it was pinned to before this fixed the gap.
      expect(usageRequests.some((url) => url.includes("window=today"))).toBe(true)

      const buttons = Array.from(container.querySelectorAll("button"))
      const sevenDays = buttons.find((button) => button.textContent === "7 days")
      expect(sevenDays).toBeDefined()

      sevenDays?.click()
      await settle()

      expect(usageRequests.some((url) => url.includes("window=7d"))).toBe(true)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("an active account with a spent window is subtracted from 'routable now'", async () => {
    // The scenario the audit named: a Claude sub at utilization 1.0 with the reset 40 minutes out
    // stays status `active` — green dot — while candidate filtering drops it and every request
    // 429s. Counting it as routable makes the headline promise capacity the router will refuse.
    stubFetch([account(), spentAccount({ id: "acct-2", label: "claude-max-spent" })])
    const { dispose, container } = mount()
    try {
      await settle()

      expect(container.textContent).toContain("1 routable now")
      // The status table's active row carries the same fact instead of a bare "yes".
      expect(container.textContent).toContain("1 window-spent now")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("with no spent window every active account counts, and no nuance is invented", async () => {
    stubFetch([account()])
    const { dispose, container } = mount()
    try {
      await settle()

      expect(container.textContent).toContain("1 routable now")
      expect(container.textContent).not.toContain("window-spent")
    } finally {
      dispose()
      container.remove()
    }
  })
})

function usageSummary(): unknown {
  const totals = {
    requests: 42,
    attempts: 45,
    errors: 3,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costMetered: "0",
    costNotional: "0",
  }
  return {
    window: "today",
    bucket: "hour",
    from: "2026-07-27T00:00:00.000Z",
    to: "2026-07-27T12:00:00.000Z",
    totals,
    latency: { p50Ms: 1, p95Ms: 2, routerOverheadP95Ms: 1, ttfbP95Ms: 1 },
    failures: { attempts: 45, errors: 3, partial: false, byOutcome: [] },
    axis: [],
    series: [],
    byKey: [],
    byAccount: [],
    byPool: [],
    byModel: [],
  }
}

function account(): unknown {
  return {
    id: "acct-1",
    label: "dev",
    provider: "anthropic",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 1,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  }
}

/** Active — green dot — but blocked by a spent five-hour window, as the server reports it. */
function spentAccount(overrides: Record<string, unknown>): unknown {
  return {
    ...(account() as Record<string, unknown>),
    ...overrides,
    availability: {
      configuredStatus: "active",
      resetsAt: null,
      resetSource: "unknown",
      lastCheckedAt: null,
      consecutiveFailures: 0,
      inFlight: 0,
      quotaWindows: [
        {
          window: "five_hour",
          utilization: 1,
          utilizationSource: "threshold-triggered",
          resetsAt: "2026-07-27T12:40:00.000Z",
          resetSource: "provider-reported",
          lastCheckedAt: "2026-07-27T12:00:00.000Z",
          spent: true,
          tokensUsed: null,
          tokenLimit: null,
        },
      ],
    },
  }
}
