import { afterEach, expect, test } from "bun:test"
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import LoginRoute, { SIGN_IN_FAILED } from "../../src/routes/LoginRoute"

/**
 * `/login?error=…` used to print the parameter verbatim inside the sign-in card — on the router's
 * real origin, under its name. A link carrying "Session locked. Call IT on 555…" rendered that
 * sentence as the console's own alert.
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test("an unknown ?error= renders one fixed sentence and never the raw value", async () => {
  globalThis.fetch = (async () =>
    Response.json({ oidc: true, local: false })) as unknown as typeof fetch
  const history = createMemoryHistory()
  const spoof = "Session locked. Call IT on 555-0100"
  history.set({ value: `/login?error=${encodeURIComponent(spoof)}` })

  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <MemoryRouter history={history}>
          <Route path="/login" component={LoginRoute} />
        </MemoryRouter>
      </QueryClientProvider>
    ),
    container,
  )
  try {
    await settle()
    expect(container.textContent).toContain(SIGN_IN_FAILED)
    expect(container.textContent).not.toContain("Call IT")
  } finally {
    dispose()
    client.clear()
    container.remove()
  }
})
