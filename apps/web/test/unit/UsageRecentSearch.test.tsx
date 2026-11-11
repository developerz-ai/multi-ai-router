import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { REQUEST_ID_DEBOUNCE_MS, UsageRecent } from "../../src/routes/usage/UsageRecent"
import { typeInto } from "../support/dom"

/** Typing an id fired one request and one cache entry per keystroke; it now waits for a pause. */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("five quick keystrokes in the request-id box send one request, carrying the final value", async () => {
  const urls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    urls.push(String(input))
    return Response.json({ attempts: [], limit: 50 })
  }) as typeof fetch

  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <UsageRecent />
      </QueryClientProvider>
    ),
    container,
  )
  try {
    await wait(20)
    const box = container.querySelector<HTMLInputElement>('input[placeholder="req-42 or a uuid"]')
    if (box === null) throw new Error("request id box missing")
    for (const value of ["r", "re", "req", "req-", "req-4"]) typeInto(box, value)
    await wait(REQUEST_ID_DEBOUNCE_MS + 100)

    const searches = urls.filter((url) => url.includes("requestId="))
    expect(searches).toHaveLength(1)
    expect(searches[0]).toContain("requestId=req-4")
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
})
