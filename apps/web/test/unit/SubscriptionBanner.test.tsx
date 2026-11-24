import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AccountView } from "../../src/lib/api/types"
import { ReconnectActions } from "../../src/routes/accounts/ReconnectActions"
import { SubscriptionBanner } from "../../src/routes/accounts/SubscriptionBanner"

const START = Date.parse("2026-11-23T00:00:00Z")

const account = (id: string, overrides: Partial<AccountView>): AccountView =>
  ({ id, label: id, provider: "anthropic-oauth", status: "active", ...overrides }) as AccountView

const ROWS = [
  account("soon", {
    credential: {
      present: true,
      expiresAt: "2026-11-24T06:00:00Z",
      subscriptionType: null,
      rateLimitTier: null,
    },
  }),
  account("dead", { status: "needs_reauth" }),
]

function withBanner(run: (root: HTMLElement, setNow: (ms: number) => void) => void): void {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const [now, setNow] = createSignal(START)
  const dispose = render(
    () => (
      <SubscriptionBanner
        accounts={ROWS}
        action={(health) => <ReconnectActions health={health()} onReconnect={() => {}} />}
        nowMs={now()}
      />
    ),
    root,
  )
  try {
    run(root, setNow)
  } finally {
    dispose()
    root.remove()
  }
}

test("the reconnect button survives the one-second tick with its focus", () => {
  withBanner((root, setNow) => {
    const button = root.querySelector("button")
    button?.focus()
    expect(document.activeElement === button).toBe(true)
    setNow(START + 1_000)
    expect(root.querySelector("button") === button).toBe(true)
    expect(document.activeElement === button).toBe(true)
  })
})

test("the login countdown follows the clock", () => {
  withBanner((root, setNow) => {
    expect(root.querySelector("li")?.textContent).toContain("1d 6h")
    setNow(START + 10 * 3_600_000)
    expect(root.querySelector("li")?.textContent).toContain("20h")
  })
})
