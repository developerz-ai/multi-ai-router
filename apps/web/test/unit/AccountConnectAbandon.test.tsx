import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import type { AccountView } from "../../src/lib/api/types"
import { AccountConnect } from "../../src/routes/accounts/AccountConnect"
import { fire, typeInto } from "../support/dom"

/** A login is one-shot server-side state: what the screen abandons, the router must hear about. */

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
const ROW = {
  id: "acc-1",
  label: "claude-1",
  provider: "anthropic-oauth",
  status: "needs_reauth",
} as AccountView
const PASTE = "https://cb.example/?code=c&state=s"

interface Stage {
  readonly calls: string[]
  readonly begin: PromiseWithResolvers<Response>[]
  readonly complete: PromiseWithResolvers<Response>[]
  readonly press: (label: string) => void
  readonly tick: (ms: number) => void
  readonly started: () => Response
}

async function stage(run: (stage: Stage) => Promise<void>): Promise<void> {
  const calls: string[] = []
  const begin: PromiseWithResolvers<Response>[] = []
  const complete: PromiseWithResolvers<Response>[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? "GET"
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if (method !== "GET") calls.push(`${method} ${url.slice(url.lastIndexOf("/accounts"))}`)
    const held = (list: PromiseWithResolvers<Response>[]) => {
      const gate = Promise.withResolvers<Response>()
      list.push(gate)
      return gate.promise
    }
    if (url.endsWith("/complete")) return held(complete)
    if (method === "POST") return held(begin)
    return Response.json(url.includes("/providers") ? { providers: [] } : [])
  }) as typeof fetch

  const [row, setRow] = createSignal<AccountView | null>(ROW)
  const [now, setNow] = createSignal(Date.now())
  const root = document.createElement("div")
  document.body.appendChild(root)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AccountConnect
          account={row()}
          connectFlow="claude-cli"
          nowMs={now()}
          onClose={() => setRow(null)}
        />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    await run({
      calls,
      begin,
      complete,
      press: (label) =>
        [...document.querySelectorAll("button")].find((b) => b.textContent === label)?.click(),
      tick: (ms) => setNow(Date.now() + ms),
      started: () =>
        Response.json({
          accountId: "acc-1",
          mode: "connect",
          authorizeUrl: "https://example.test/authorize",
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          capture: "paste",
        }),
    })
  } finally {
    dispose()
    client.clear()
    root.remove()
  }
}

const DELETE = "DELETE /accounts/acc-1/connect"
const box = () => document.querySelector<HTMLTextAreaElement>("textarea")
const submitPaste = () => {
  const area = box()
  const form = area?.closest("form")
  if (!area || !form) throw new Error("paste form missing")
  typeInto(area, PASTE)
  fire(form, "submit")
}

test("closing while the login is being started cancels it once it exists", () =>
  stage(async (s) => {
    s.press("Start re-authorization")
    s.press("Start login")
    await settle()
    s.press("Cancel")
    await settle()
    expect(s.calls).not.toContain(DELETE)
    s.begin[0]?.resolve(s.started())
    await settle()
    expect(s.calls).toContain(DELETE)
  }))

test("closing while a code is being redeemed cancels only if the redemption fails", () =>
  stage(async (s) => {
    s.press("Start re-authorization")
    s.press("Start login")
    await settle()
    s.begin[0]?.resolve(s.started())
    await settle()
    submitPaste()
    await settle()
    s.press("Cancel")
    await settle()
    expect(s.calls).not.toContain(DELETE)
    s.complete[0]?.resolve(new Response("", { status: 400 }))
    await settle()
    expect(s.calls).toContain(DELETE)
  }))

test("closing while a code is being redeemed leaves a login that succeeds alone", () =>
  stage(async (s) => {
    s.press("Start re-authorization")
    s.press("Start login")
    await settle()
    s.begin[0]?.resolve(s.started())
    await settle()
    submitPaste()
    await settle()
    s.press("Cancel")
    s.complete[0]?.resolve(Response.json({ accountId: "acc-1", connected: true }))
    await settle()
    expect(s.calls.some((call) => call.endsWith("/connect/complete"))).toBe(true)
    expect(s.calls).not.toContain(DELETE)
  }))

test("starting again drops the refused code and its message", () =>
  stage(async (s) => {
    s.press("Start re-authorization")
    s.press("Start login")
    await settle()
    s.begin[0]?.resolve(s.started())
    await settle()
    submitPaste()
    await settle()
    s.complete[0]?.resolve(Response.json({ error: { message: "code refused" } }, { status: 400 }))
    await settle()
    expect(document.body.textContent).toContain("code refused")
    s.tick(700_000)
    s.press("Start again")
    await settle()
    s.begin[1]?.resolve(s.started())
    await settle()
    s.tick(0)
    expect(document.body.textContent).not.toContain("code refused")
    expect(box()?.value).toBe("")
  }))
