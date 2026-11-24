import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import { outcomeBadge } from "../../src/routes/egress/egress-copy"
import { EgressProxiesSection } from "../../src/routes/settings/EgressProxiesSection"
import { assignment, overview } from "../support/egress"
import { settle, withSection } from "../support/egress-section"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

test("two accounts tested at once each get their own answer", () => {
  const answers = ["ok", "timeout"]
  return withSection(
    overview({ assigned: [assignment(), assignment({ id: "b", label: "or-two" })] }),
    async (root, calls) => {
      for (const label of ["or-main", "or-two"]) {
        root
          .querySelector<HTMLButtonElement>(`button[aria-label="Test the proxy of ${label} now"]`)
          ?.click()
      }
      await settle()
      expect(calls).toHaveLength(2)
      const status = [...root.querySelectorAll('tr [role="status"]')].map((n) => n.textContent)
      expect(status[0]).toContain("ok")
      expect(status[1]).toContain("timed out")
    },
    () =>
      Response.json({
        outcome: answers.shift(),
        status: null,
        latencyMs: 5,
        checkedAt: new Date().toISOString(),
        nextAllowedAt: new Date().toISOString(),
      }),
  )
})

test("a server error that carries a retry deadline is not a cooldown: its sentence is shown", () =>
  withSection(
    overview({ assigned: [assignment()] }),
    async (root) => {
      root
        .querySelector<HTMLButtonElement>('button[aria-label="Test the proxy of or-main now"]')
        ?.click()
      await settle()
      expect(root.textContent).toContain("webshare could not be reached")
      expect(root.textContent).not.toContain("Tested moments ago")
    },
    () =>
      Response.json(
        { error: { message: "webshare could not be reached", code: "webshare_unavailable" } },
        { status: 503, headers: { "retry-after": "5" } },
      ),
  ))

test("a test updates its own row without asking the vendors again, and belongs to one proxy", async () => {
  let reads = 0
  let view = overview({
    assigned: [assignment({ healthOf: { outcome: "timeout", consecutiveFailures: 2 } })],
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if (init?.method === "POST") {
      return Response.json({
        outcome: "ok",
        status: 200,
        latencyMs: 777,
        checkedAt: new Date().toISOString(),
        nextAllowedAt: new Date(Date.now() + 60_000).toISOString(),
      })
    }
    reads += 1
    return Response.json(view)
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
    const button = () =>
      root.querySelector<HTMLButtonElement>('button[aria-label="Test the proxy of or-main now"]')
    expect(root.textContent).toContain("2 failed checks")
    button()?.click()
    await settle()
    expect(reads).toBe(1)
    expect(root.textContent).not.toContain("failed check")
    expect(button()?.disabled).toBe(true)

    view = overview({ assigned: [assignment({ address: "198.51.100.9:1" })] })
    await client.refetchQueries({ queryKey: ["egress-proxies"] })
    await settle()
    expect(root.textContent).toContain("198.51.100.9:1")
    expect(root.textContent).not.toContain("777 ms")
    expect(button()?.disabled).toBe(false)
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
})

test("a passed test claims no more than it tried", () => {
  expect(outcomeBadge("ok").hint).not.toContain("the account's upstream.")
  expect(outcomeBadge("ok").hint).toContain("neutral host")
})

test("a test inside its cooldown counts down to the next one, and holds the button", () =>
  withSection(
    overview({ assigned: [assignment()] }),
    async (root) => {
      const button = () =>
        root.querySelector<HTMLButtonElement>('button[aria-label="Test the proxy of or-main now"]')
      button()?.click()
      await settle()
      expect(root.textContent).toContain("Tested moments ago. Next test in ")
      expect(button()?.disabled).toBe(true)
    },
    () =>
      Response.json(
        { error: { message: "tested moments ago — in 50s", code: "proxy_test_cooldown" } },
        { status: 429, headers: { "retry-after": "50" } },
      ),
  ))

test("a refused target proves the proxy alive: the dead-proxy banner goes with the count", () =>
  withSection(
    overview({
      assigned: [
        assignment({
          replace: "on-failure",
          healthOf: { outcome: "timeout", consecutiveFailures: 3, repair: "no_candidate" },
        }),
      ],
    }),
    async (root) => {
      expect(root.textContent).toContain("1 dead proxy was not replaced")
      root
        .querySelector<HTMLButtonElement>('button[aria-label="Test the proxy of or-main now"]')
        ?.click()
      await settle()
      expect(root.textContent).toContain("target refused")
      expect(root.textContent).not.toContain("dead proxy was not replaced")
      expect(root.textContent).not.toContain("failed check")
    },
    () =>
      Response.json({
        outcome: "refused",
        status: 403,
        latencyMs: 5,
        checkedAt: new Date().toISOString(),
        nextAllowedAt: new Date().toISOString(),
      }),
  ))
