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

/**
 * Production, 2026-10-04: an `openai-oauth` connect showed "Connected … Delivered by redirect
 * capture" while the server had exchanged nothing — `POST /connect` itself bumps `updatedAt`
 * (it records the authorization attempt), and the redirect watcher read "the row changed" as
 * "the login landed". The row is the record only when it says a credential arrived.
 */
describe("AccountConnect redirect watcher", () => {
  function mountOAuth(rowAfterBegin: () => AccountView) {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? "GET"} ${url}`)
      if (url.endsWith("/connect")) {
        return Response.json({
          accountId: "acc-1",
          mode: "connect",
          authorizeUrl: "https://auth.example.test/oauth/authorize?state=s",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          capture: "redirect",
          redirectUri: "https://router.example.test/admin/accounts/oauth/callback",
        })
      }
      if (url.endsWith("/accounts/acc-1")) return Response.json(rowAfterBegin())
      return Response.json([])
    }) as typeof fetch

    const before = account({
      provider: "openai-oauth",
      label: "codex-1",
      configDir: null,
      dialect: "openai-responses",
      credential: null,
    })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <QueryClientProvider client={client}>
          <AccountConnect
            account={before}
            connectFlow="oauth"
            nowMs={Date.now()}
            onClose={() => {}}
          />
        </QueryClientProvider>
      ),
      container,
    )
    const start = [...document.body.querySelectorAll("button")].find(
      (b) => b.textContent === "Start login",
    )
    start?.click()
    return {
      calls,
      dispose: () => {
        dispose()
        container.remove()
      },
    }
  }

  test("a row touched by the start itself is not a completed login", async () => {
    const mounted = mountOAuth(() =>
      account({
        provider: "openai-oauth",
        label: "codex-1",
        configDir: null,
        dialect: "openai-responses",
        credential: null,
        // What the start's own write does to the row: a new `updatedAt`, nothing else.
        updatedAt: "2026-10-04T20:06:32.000Z",
      }),
    )
    try {
      await settle()
      await settle()
      expect(
        mounted.calls.some((call) => call.startsWith("POST") && call.endsWith("/connect")),
      ).toBe(true)
      expect(document.body.textContent).not.toContain("Connected.")
      expect(document.body.textContent).not.toContain("capture.")
      expect(document.body.textContent).toContain("https://auth.example.test/oauth/authorize")
      expect(document.body.querySelector("textarea")).not.toBeNull()
    } finally {
      mounted.dispose()
    }
  })

  test("a credential arriving on the row is noticed, without claiming how it was delivered", async () => {
    const mounted = mountOAuth(() =>
      account({
        provider: "openai-oauth",
        label: "codex-1",
        configDir: null,
        dialect: "openai-responses",
        credential: null,
        status: "active",
        hasCredential: true,
        tokenExpiresAt: "2026-10-14T20:06:50.000Z",
        updatedAt: "2026-10-04T20:06:50.000Z",
      }),
    )
    try {
      await settle()
      await settle()
      expect(document.body.textContent).toContain("Connected.")
      expect(document.body.textContent).not.toContain("capture.")
    } finally {
      mounted.dispose()
    }
  })
})

describe("AccountConnect loopback paste", () => {
  test("names the loopback, says its error page is expected, and submits the whole URL", async () => {
    const posted: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/connect/complete")) {
        posted.push(String(init?.body ?? ""))
        return Response.json({
          accountId: "acc-1",
          mode: "connect",
          connected: true,
          capture: "paste",
        })
      }
      if (url.endsWith("/connect")) {
        return Response.json({
          accountId: "acc-1",
          mode: "connect",
          authorizeUrl: "https://auth.example.test/oauth/authorize?state=s",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          capture: "paste",
          redirectUri: "http://localhost:1455/auth/callback",
        })
      }
      return Response.json([])
    }) as typeof fetch

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => (
        <QueryClientProvider client={client}>
          <AccountConnect
            account={account({ provider: "openai-oauth", configDir: null, credential: null })}
            connectFlow="oauth"
            nowMs={Date.now()}
            onClose={() => {}}
          />
        </QueryClientProvider>
      ),
      container,
    )
    try {
      const buttons = () => [...document.body.querySelectorAll("button")]
      buttons()
        .find((b) => b.textContent === "Start login")
        ?.click()
      await settle()
      const text = document.body.textContent ?? ""
      expect(text).toContain("http://localhost:1455/auth/callback?code=")
      expect(text).toContain("That is expected")
      expect(text).toContain("whole address")
      expect(text).not.toContain("Or let the browser come back")

      const paste = document.body.querySelector("textarea")
      if (paste === null) throw new Error("no paste box")
      const full = "http://localhost:1455/auth/callback?code=ac_x&scope=openid&state=s"
      paste.value = full
      paste.dispatchEvent(
        new (await import("./../support/solid-plugin")).DomEvent("input", { bubbles: true }),
      )
      buttons()
        .find((b) => b.textContent === "Complete login")
        ?.click()
      await settle()
      expect(posted).toHaveLength(1)
      expect(JSON.parse(posted[0] ?? "{}")).toEqual({ pasted: full })
      expect(document.body.textContent).toContain("Connected.")
      expect(document.body.textContent).toContain("paste")
    } finally {
      dispose()
      container.remove()
    }
  })
})
