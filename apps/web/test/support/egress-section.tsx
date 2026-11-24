import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { EgressOverview } from "../../src/lib/api/egress"
import { EgressProxiesSection } from "../../src/routes/settings/EgressProxiesSection"

export const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

/** Mounts the section over one stubbed overview. The caller restores `fetch`. */
export async function withSection(
  view: EgressOverview,
  run: (root: HTMLElement, calls: string[]) => Promise<void> | void,
  write: () => Response = () => Response.json({}),
): Promise<void> {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if ((init?.method ?? "GET") !== "GET") {
      calls.push(`${init?.method} ${url.replace("/api/admin", "")} ${init?.body ?? ""}`.trim())
      return write()
    }
    return Response.json(url.includes("/egress-proxies") ? view : [])
  }) as typeof fetch
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <EgressProxiesSection />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    await run(root, calls)
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
}
