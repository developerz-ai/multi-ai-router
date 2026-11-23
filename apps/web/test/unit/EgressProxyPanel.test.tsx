import { expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { EgressProxyPanel } from "../../src/routes/accounts/EgressProxyPanel"
import { fire } from "../support/dom"

const account = (egressProxy: string | null) => ({ id: "a", egressProxy }) as AccountView

function mount(row: AccountView, shown: boolean, run: (root: HTMLElement) => void) {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  client.setQueryData(["egress-proxies"], {
    configured: true,
    proxies: [
      {
        vendor: "webshare",
        id: "d-1",
        address: "203.0.113.7:6754",
        location: "Buffalo, US",
        valid: true,
      },
    ],
  })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <EgressProxyPanel account={row} shown={shown} />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    run(root)
  } finally {
    dispose()
    root.remove()
  }
}

test("a provider that signs in shows nothing: the API refuses it a proxy", () => {
  mount(account(null), false, (root) => expect(root.textContent).toBe(""))
})

test("the stored proxy is shown as host and port, and the box opens empty", () => {
  mount(account("p.test:8080"), true, (root) => {
    expect(root.textContent).toContain("p.test:8080")
    fire(root.querySelector("button") as HTMLButtonElement, "click")
    expect(root.querySelector("input")?.value).toBe("")
    expect(root.textContent).toContain("Remove proxy")
    expect(root.textContent).toContain("203.0.113.7:6754 Buffalo, US")
  })
})

test("with none set there is nothing to remove", () => {
  mount(account(null), true, (root) => {
    expect(root.textContent).toContain("none, direct")
    fire(root.querySelector("button") as HTMLButtonElement, "click")
    expect(root.textContent).not.toContain("Remove proxy")
  })
})
