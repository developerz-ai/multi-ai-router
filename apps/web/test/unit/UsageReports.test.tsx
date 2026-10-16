import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { UsageReports } from "../../src/routes/usage/UsageReports"

/**
 * The weekly-reports list and its one control (issue #229): the re-send button says it posts to
 * the channel, issues exactly one POST for the week clicked, and shows the outcome the server
 * returned — including a delivery that failed, which is a 200 with a status, not an HTTP error.
 * Fetch is stubbed at the boundary; nothing here reaches a server, let alone Discord.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const REPORT = {
  periodStart: "2026-10-05",
  periodEnd: "2026-10-12",
  generatedAt: "2026-10-12T00:30:00.000Z",
  deliveryStatus: "pending",
  deliveryAttempts: 0,
  deliveredAt: null,
  lastError: null,
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

function stubFetch(deliver: () => Response): string[] {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(`${init?.method ?? "GET"} ${url}`)
    if (url.endsWith("/deliver")) return deliver()
    return Response.json({ reports: [REPORT] })
  }) as typeof fetch
  return calls
}

async function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const node = document.createElement("div")
  document.body.append(node)
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <UsageReports />
      </QueryClientProvider>
    ),
    node,
  )
  await settle()
  return {
    node,
    text: () => node.textContent ?? "",
    click: () => {
      const button = node.querySelector("button")
      expect(button).not.toBeNull()
      button?.click()
    },
    dispose: () => {
      dispose()
      node.remove()
    },
  }
}

describe("UsageReports re-send", () => {
  test("lists the stored week with a control that says it posts to the channel", async () => {
    const calls = stubFetch(() => Response.json({}))
    const view = await mount()
    try {
      expect(view.text()).toContain("2026-10-05 to 2026-10-12")
      expect(view.text()).toContain("Pending")
      const button = view.node.querySelector("button")
      expect(button?.textContent).toBe("Resend to channel")
      expect(button?.getAttribute("title")).toContain("Discord channel")
      expect(button?.getAttribute("aria-label")).toContain("week of 2026-10-05")
      expect(calls).toEqual(["GET /api/admin/usage/reports"])
    } finally {
      view.dispose()
    }
  })

  test("a successful re-send posts the week once, shows the outcome and refreshes the list", async () => {
    const calls = stubFetch(() =>
      Response.json({
        periodStart: "2026-10-05",
        deliveryStatus: "sent",
        deliveryAttempts: 1,
        deliveredAt: "2026-10-15T09:00:00.000Z",
      }),
    )
    const view = await mount()
    try {
      view.click()
      await settle()
      expect(calls).toContain("POST /api/admin/usage/reports/2026-10-05/deliver")
      expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(1)
      expect(view.text()).toContain("Posted to the channel.")
      // The settled mutation invalidated the list: the Delivery column re-reads the new state.
      expect(
        calls.filter((call) => call === "GET /api/admin/usage/reports").length,
      ).toBeGreaterThan(1)
    } finally {
      view.dispose()
    }
  })

  test("a failed delivery is a 200 whose reason is shown, not swallowed", async () => {
    stubFetch(() =>
      Response.json({
        periodStart: "2026-10-05",
        deliveryStatus: "failed",
        deliveryAttempts: 1,
        deliveredAt: null,
        lastError: "discord webhook answered 500",
      }),
    )
    const view = await mount()
    try {
      view.click()
      await settle()
      expect(view.text()).toContain("Delivery failed: discord webhook answered 500")
    } finally {
      view.dispose()
    }
  })

  test("an unconfigured webhook names the environment variable", async () => {
    stubFetch(() =>
      Response.json({
        periodStart: "2026-10-05",
        deliveryStatus: "not_configured",
        deliveryAttempts: 0,
        deliveredAt: null,
      }),
    )
    const view = await mount()
    try {
      view.click()
      await settle()
      expect(view.text()).toContain("USAGE_REPORT_DISCORD_WEBHOOK_URL")
    } finally {
      view.dispose()
    }
  })

  test("an HTTP-level refusal shows the server's own sentence", async () => {
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            error: {
              message: "the report was claimed for delivery between this call's read and its claim",
              type: "invalid_request_error",
              code: "delivery_claim_lost",
            },
          }),
          { status: 409, headers: { "content-type": "application/json" } },
        ),
    )
    const view = await mount()
    try {
      view.click()
      await settle()
      expect(view.text()).toContain("claimed for delivery")
    } finally {
      view.dispose()
    }
  })
})
