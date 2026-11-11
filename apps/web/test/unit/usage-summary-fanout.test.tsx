import { afterEach, expect, test } from "bun:test"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { useUsageSummary } from "../../src/lib/queries/usage"
import { QUERY_DEFAULTS } from "../../src/lib/query"
import { wireSummary } from "../support/usage-wire"

/**
 * One usage summary is a couple of dozen aggregates over raw usage rows on the server, and the
 * accounts and keys tables read the 7-day one as well. Under the console's 15 s default every tab
 * refocus re-ran all of them; a refocus within a minute must be a cache hit.
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  focusManager.setFocused(undefined)
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("refocusing the tab soon after a summary loaded does not re-aggregate it", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return Response.json(wireSummary())
  }) as unknown as typeof fetch

  const client = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, staleTime: 0 } },
  })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        {(() => {
          useUsageSummary(() => "7d")
          return null
        })()}
      </QueryClientProvider>
    ),
    container,
  )
  try {
    await wait(20)
    expect(calls).toBe(1)
    focusManager.setFocused(false)
    focusManager.setFocused(true)
    await wait(20)
    expect(calls).toBe(1)
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
})
