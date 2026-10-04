import { afterEach, describe, expect, test } from "bun:test"
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { AccountConnect } from "../../src/routes/accounts/AccountConnect"

/**
 * The device-code block in the connect dialog: offered only where the provider declares it, shows
 * the code and the page while the server says "waiting", and says "Connected" only when the server
 * does. Fetch is stubbed at the boundary; nothing reaches a server.
 */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const ACCOUNT: AccountView = {
  id: "acc-d",
  label: "codex-remote",
  provider: "openai-oauth",
  status: "needs_reauth",
  hasCredential: false,
  configDir: null,
  baseUrl: null,
  dialect: "openai-responses",
  modelAliases: null,
  supportedModels: null,
  windowTokenLimits: null,
  weight: 100,
  priority: 1,
  billing: "subscription",
  tokenExpiresAt: null,
  lastUsedAt: null,
  createdAt: "2026-10-04T00:00:00.000Z",
  updatedAt: "2026-10-04T00:00:00.000Z",
  credential: null,
}

const STARTED = {
  accountId: "acc-d",
  mode: "connect",
  verificationUrl: "https://auth.example.test/codex/device",
  userCode: "QRST-5678",
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
  intervalSeconds: 1,
}

function settle(ms = 40): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function stub(statuses: unknown[], deviceSignIn = true) {
  const calls: string[] = []
  let reads = 0
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url}`)
    if (url.endsWith("/providers")) {
      return Response.json({
        providers: [{ id: "openai-oauth", connectFlow: "oauth", deviceSignIn }],
      })
    }
    if (url.includes("/connect/device") && method === "POST") return Response.json(STARTED)
    if (url.includes("/connect/device")) {
      const body = statuses[Math.min(reads, statuses.length - 1)]
      reads += 1
      return Response.json(body)
    }
    return Response.json([])
  }) as typeof fetch
  return calls
}

function mount(extra: { autoBegin?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AccountConnect
          account={ACCOUNT}
          autoBegin={extra.autoBegin === true}
          connectFlow="oauth"
          nowMs={Date.now()}
          onClose={() => {}}
        />
      </QueryClientProvider>
    ),
    container,
  )
  return () => {
    dispose()
    container.remove()
  }
}

const button = (label: string) =>
  [...document.body.querySelectorAll("button")].find((b) => b.textContent === label)

describe("device-code sign-in in the connect dialog", () => {
  test("shows the code and the page while waiting, and Connected only when the server says so", async () => {
    const calls = stub([
      { status: "waiting", ...STARTED },
      {
        status: "connected",
        completed: { accountId: "acc-d", mode: "connect", connected: true, capture: "device" },
      },
    ])
    const dispose = mount()
    try {
      await settle()
      button("Get a code")?.click()
      await settle()
      const text = () => document.body.textContent ?? ""
      expect(
        calls.some((c) => c.startsWith("POST") && c.endsWith("/connect/device?mode=connect")),
      ).toBe(true)
      expect(text()).toContain("QRST-5678")
      expect(text()).toContain("https://auth.example.test/codex/device")
      expect(text()).toContain("Waiting for you to approve")
      expect(text()).not.toContain("Connected.")

      await settle(1_200)
      expect(text()).toContain("Connected.")
      expect(text()).toContain("device")
      expect(text()).not.toContain("QRST-5678")
    } finally {
      dispose()
    }
  })

  test("a refusal says so and offers a new code; it never says Connected", async () => {
    stub([{ status: "denied", accountId: "acc-d" }])
    const dispose = mount()
    try {
      await settle()
      button("Get a code")?.click()
      await settle(80)
      const text = document.body.textContent ?? ""
      expect(text).toContain("The provider refused this sign-in")
      expect(text).not.toContain("Connected.")
      expect(button("Get a new code")).toBeDefined()
    } finally {
      dispose()
    }
  })

  test("D. device-only: no paste-back, no Start login — Get a code is the whole flow", async () => {
    const calls = stub([{ status: "waiting", ...STARTED }])
    const dispose = mount()
    try {
      await settle()
      expect(button("Get a code")).toBeDefined()
      expect(button("Start login")).toBeUndefined()
      expect(document.body.querySelector("textarea")).toBeNull()
      expect(document.body.textContent ?? "").not.toContain("authorization-code exchange")
      expect(calls.some((c) => c.startsWith("POST") && /\/connect$/.test(c))).toBe(false)
    } finally {
      dispose()
    }
  })

  test("D. a guided run starts the device sign-in, never paste-back", async () => {
    const calls = stub([{ status: "waiting", ...STARTED }])
    const dispose = mount({ autoBegin: true })
    try {
      await settle(80)
      expect(calls.some((c) => c.startsWith("POST") && c.includes("/connect/device"))).toBe(true)
      expect(calls.some((c) => c.startsWith("POST") && /\/connect$/.test(c))).toBe(false)
      expect(document.body.textContent ?? "").toContain("QRST-5678")
    } finally {
      dispose()
    }
  })

  test("E. keeps polling while the console tab is in the background", async () => {
    const calls = stub([{ status: "waiting", ...STARTED }])
    const dispose = mount()
    try {
      await settle()
      button("Get a code")?.click()
      await settle()
      focusManager.setFocused(false)
      const before = calls.filter(
        (c) => c.startsWith("GET") && c.includes("/connect/device"),
      ).length
      await settle(2_300)
      const after = calls.filter((c) => c.startsWith("GET") && c.includes("/connect/device")).length
      expect(after).toBeGreaterThan(before)
    } finally {
      focusManager.setFocused(undefined)
      dispose()
    }
  })

  test("not offered where the provider declares no device flow", async () => {
    stub([], false)
    const dispose = mount()
    try {
      await settle()
      expect(button("Get a code")).toBeUndefined()
    } finally {
      dispose()
    }
  })
})
