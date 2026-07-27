import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import UsageRoute from "../../src/routes/UsageRoute"

/**
 * The usage screen mounted whole against a stubbed `fetch`.
 *
 * The panels are unit-tested from props; what only a mounted route can prove is
 * that they are **wired to the wire** — that `GET /api/admin/usage` reaches the
 * failure panel with its numbers intact. A panel that renders perfectly from
 * props and is never handed the response is exactly the shape of bug a
 * component test cannot see.
 *
 * The claim under test is the one an operator arrives with: the screen does not
 * stop at "2.4% failed". It says which failure that was, and what to do about
 * each — with rate limited and out of credits as two rows, never one.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(failures: unknown): void {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString()
    return new Response(JSON.stringify(responseFor(url, failures)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

function responseFor(url: string, failures: unknown): unknown {
  if (url.includes("/usage/recent")) return { attempts: [], limit: 50 }
  if (url.includes("/usage")) return summary(failures)
  return []
}

function mount(): { readonly dispose: () => void; readonly container: HTMLElement } {
  const container = document.createElement("div")
  document.body.appendChild(container)
  // No retries: a stubbed response that does not parse should fail the test rather than be
  // quietly attempted three more times behind a loading skeleton.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <UsageRoute />
      </QueryClientProvider>
    ),
    container,
  )
  return { dispose, container }
}

/** Solid renders synchronously; what is awaited here is the stubbed round trip. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

describe("UsageRoute", () => {
  test("takes the error rate apart instead of leaving it as one percentage", async () => {
    stubFetch({
      attempts: 100,
      errors: 10,
      partial: false,
      byOutcome: [
        { outcome: "quota_exhausted", attempts: 6 },
        { outcome: "credits_exhausted", attempts: 3 },
        { outcome: "scope_violation", attempts: 1 },
      ],
    })
    const { dispose, container } = mount()
    try {
      await settle()

      const text = container.textContent ?? ""
      // The tile is still there, and is no longer the last word on it.
      expect(text).toContain("Error rate")
      expect(text).toContain("Why requests failed")
      // Three remedies, three statuses — the distinction non-negotiable 7 exists for.
      expect(text).toContain("Rate limited")
      expect(text).toContain("Out of credits")
      expect(text).toContain("Out of scope")
      expect(text).toContain("429")
      expect(text).toContain("402")
      expect(text).toContain("403")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("narrows the split at the edge, so success is never drawn as a failure", async () => {
    // The server filters it; the console filters it again rather than trusting the wire.
    stubFetch({
      attempts: 10,
      errors: 1,
      partial: false,
      byOutcome: [
        { outcome: "success", attempts: 9 },
        { outcome: "upstream_timeout", attempts: 1 },
      ],
    })
    const { dispose, container } = mount()
    try {
      await settle()

      const text = container.textContent ?? ""
      expect(text).toContain("Upstream failed")
      // "1 of 10 attempts", not "10 of 10": recomputed from the rows that survived the filter.
      expect(text).toContain("1 of 10 attempts")
    } finally {
      dispose()
      container.remove()
    }
  })
})

function summary(failures: unknown): unknown {
  const totals = {
    requests: 100,
    attempts: 100,
    errors: 10,
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
    latency: { p50Ms: 1, p95Ms: 2, routerOverheadP95Ms: 1, ttfbP95Ms: 1 },
    failures,
    axis: [],
    series: [],
    byKey: [],
    byAccount: [],
    byPool: [],
    byModel: [],
  }
}
