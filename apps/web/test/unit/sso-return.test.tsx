import { afterEach, expect, test } from "bun:test"
import { createMemoryHistory, MemoryRouter, Route, useLocation } from "@solidjs/router"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import AppLayout from "../../src/layout/AppLayout"
import { clearSession } from "../../src/lib/api/session"
import LoginRoute from "../../src/routes/LoginRoute"

/** The whole hop: a filtered link, a sign-in at a provider, and the shell its callback lands on. */

const originalFetch = globalThis.fetch
const originalAssign = window.location.assign
afterEach(() => {
  globalThis.fetch = originalFetch
  window.location.assign = originalAssign
  sessionStorage.clear()
  clearSession()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))

async function visit(path: string, run: (root: HTMLElement) => void): Promise<void> {
  const history = createMemoryHistory()
  history.set({ value: path })
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Where = () => {
    const location = useLocation()
    return <p id="where">{`${location.pathname}${location.search}`}</p>
  }
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <MemoryRouter history={history}>
          <Route component={LoginRoute} path="/login" />
          <Route component={AppLayout} path="/">
            <Route component={Where} path="/" />
            <Route component={Where} path="/usage" />
          </Route>
        </MemoryRouter>
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    run(root)
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
}

test("a filtered view survives single sign-on, and only once", async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("/auth/methods")
      ? Response.json({ oidc: true, local: false })
      : Response.json({ username: "a", csrfToken: "t", version: "1" })) as typeof fetch
  const gone: string[] = []
  window.location.assign = (url: string | URL) => void gone.push(String(url))

  const view = "/usage?window=30d&owner=marta"
  await visit(`/login?next=${encodeURIComponent(view)}`, (root) => {
    const start = [...root.querySelectorAll("button")].find((b) => b.textContent?.includes("SSO"))
    start?.click()
  })
  expect(gone).toEqual(["/api/admin/auth/oidc/start"])

  // The provider's callback always answers `/`.
  await visit("/", (root) => expect(root.querySelector("#where")?.textContent).toBe(view))
  await visit("/", (root) => expect(root.querySelector("#where")?.textContent).toBe("/"))
})
