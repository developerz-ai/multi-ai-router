import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { AccountDisableDialog } from "../../src/routes/accounts/AccountDisableDialog"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})

const ACCOUNT = { id: "a", label: "claude-1", status: "active" } as AccountView

function mount(onClose: () => void): () => void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <AccountDisableDialog account={ACCOUNT} onClose={onClose} pools={[]} />
      </QueryClientProvider>
    ),
    container,
  )
  return () => {
    dispose()
    container.remove()
  }
}

function confirmButton(): HTMLButtonElement {
  const button = [...document.body.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === "Disable account",
  )
  if (button === undefined) throw new Error("no confirm button")
  return button
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("AccountDisableDialog", () => {
  test("sends nothing until the operator confirms", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls += 1
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch
    const unmount = mount(() => {})
    try {
      await settle()
      expect(calls).toBe(0)
      expect(document.body.textContent).toContain("claude-1")
    } finally {
      unmount()
    }
  })

  test("a refusal stays on screen instead of vanishing with the click", async () => {
    let closed = false
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { code: "x", message: "the router said no" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    const unmount = mount(() => {
      closed = true
    })
    try {
      confirmButton().click()
      await settle()
      expect(closed).toBe(false)
      expect(document.body.querySelector("[role=alert]")).not.toBeNull()
    } finally {
      unmount()
    }
  })
})
