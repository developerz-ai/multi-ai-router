import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { AccountConnect } from "../../src/routes/accounts/AccountConnect"

/**
 * The guided "Reconnect all" run hands `AccountConnect` a fresh `AccountView` on every refetch —
 * and every completed step *causes* a refetch. Keyed on the object rather than the id, the
 * auto-begin effect restarted the login on each one: an unbounded run of `POST /connect`, each
 * spawning a real `claude` subprocess on the router. This is the gate against that coming back.
 *
 * Fetch is stubbed at the boundary; nothing here reaches a server, let alone a CLI.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "acc-1",
    label: "claude-max-1",
    provider: "anthropic-oauth",
    status: "needs_reauth",
    hasCredential: false,
    configDir: "/data/claude/acc-1",
    baseUrl: null,
    dialect: "anthropic",
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 1,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    credential: { expiresAt: null, subscriptionType: "max", rateLimitTier: null, present: false },
    ...overrides,
  }
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30))
}

describe("AccountConnect with autoBegin", () => {
  test("starts one login per account id — a refetched, equal-but-new row does not restart it", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.endsWith("/reconnect") || url.endsWith("/connect")) {
        return Response.json({
          accountId: "acc-1",
          mode: "reconnect",
          authorizeUrl: "https://example.test/authorize",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          capture: "paste",
        })
      }
      return Response.json([])
    }) as typeof fetch

    const [row, setRow] = createSignal<AccountView | null>(account())
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <QueryClientProvider client={client}>
          <AccountConnect
            account={row()}
            autoBegin
            connectFlow="claude-cli"
            nowMs={Date.now()}
            onClose={() => {}}
            progress={{ index: 1, total: 2 }}
          />
        </QueryClientProvider>
      ),
      container,
    )
    try {
      await settle()
      const begins = () => calls.filter((call) => /\/(re)?connect$/.test(call))
      expect(begins()).toHaveLength(1)
      expect(begins()[0]).toContain("POST")
      // The dialog renders through a Portal into `document.body`, not into the mount container.
      expect(document.body.textContent).toContain("Reconnect 1 of 2")
      expect(document.body.textContent).toContain("https://example.test/authorize")

      // The list refetches and hands back the same account as a new object.
      setRow(account({ updatedAt: "2026-08-02T00:00:00.000Z" }))
      await settle()
      expect(begins()).toHaveLength(1)
      expect(document.body.textContent).toContain("https://example.test/authorize")

      // A different account is a different login.
      setRow(account({ id: "acc-2", label: "claude-max-2" }))
      await settle()
      expect(begins()).toHaveLength(2)
    } finally {
      dispose()
      container.remove()
    }
  })

  test("the dialog offers skip while pending and next once completed", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith("/connect/complete")) {
        return Response.json({ accountId: "acc-1", mode: "reconnect", connected: true })
      }
      return Response.json({
        accountId: "acc-1",
        mode: "reconnect",
        authorizeUrl: "https://example.test/authorize",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        capture: "paste",
      })
    }) as typeof fetch

    let skipped = 0
    let advanced = 0
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <QueryClientProvider client={client}>
          <AccountConnect
            account={account()}
            autoBegin
            connectFlow="claude-cli"
            nowMs={Date.now()}
            onClose={() => {}}
            onNext={() => {
              advanced += 1
            }}
            onSkip={() => {
              skipped += 1
            }}
            progress={{ index: 2, total: 2 }}
          />
        </QueryClientProvider>
      ),
      container,
    )
    try {
      await settle()
      const buttons = () => [...document.body.querySelectorAll("button")]
      expect(buttons().some((b) => b.textContent === "Skip this account")).toBe(true)
      expect(buttons().some((b) => b.textContent === "Finish")).toBe(false)

      const paste = document.body.querySelector("textarea")
      expect(paste).not.toBeNull()
      if (paste === null) return
      paste.value = "code#state"
      paste.dispatchEvent(
        new (await import("./../support/solid-plugin")).DomEvent("input", { bubbles: true }),
      )
      const complete = buttons().find((b) => b.textContent === "Complete login")
      expect(complete).toBeDefined()
      complete?.click()
      await settle()

      expect(document.body.textContent).toContain("Re-authorized.")
      const finish = buttons().find((b) => b.textContent === "Finish")
      expect(finish).toBeDefined()
      expect(buttons().some((b) => b.textContent === "Skip this account")).toBe(false)
      finish?.click()
      expect(advanced).toBe(1)
      expect(skipped).toBe(0)
    } finally {
      dispose()
      container.remove()
    }
  })
})
