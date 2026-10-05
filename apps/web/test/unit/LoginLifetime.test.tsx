import { describe, expect, test } from "bun:test"
import { type JSX, render } from "solid-js/web"
import type { AccountView, SubscriptionCredentialView } from "../../src/lib/api/types"
import { summarizeSubscriptions } from "../../src/lib/subscription-login"
import { CredentialCell } from "../../src/routes/accounts/CredentialCell"
import { LoginLifetimeSummary } from "../../src/routes/accounts/LoginLifetimeSummary"
import { ReconnectActions } from "../../src/routes/accounts/ReconnectActions"
import { SubscriptionBanner } from "../../src/routes/accounts/SubscriptionBanner"

/**
 * The console's login-lifetime surfaces: the row cell and the account dialog say "login renews in
 * N days (reported|estimated)", the banner names the server's warn window, and "Reconnect expiring"
 * hands exactly the expiring accounts to the one guided reconnect sequence.
 */

const NOW = Date.parse("2026-10-04T12:00:00.000Z")
const DAY = 86_400_000

function credential(overrides: Partial<SubscriptionCredentialView>): SubscriptionCredentialView {
  return {
    expiresAt: null,
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    present: true,
    accessTokenExpiresAt: "2026-10-04T18:00:00.000Z",
    lastLoginAt: "2026-09-07T10:00:00.000Z",
    renewsAt: null,
    renewsAtSource: "unknown",
    daysUntilRenewal: null,
    renewalRequiredSoon: false,
    renewalWarnDays: 5,
    ...overrides,
  }
}

function sub(id: string, cred: SubscriptionCredentialView | null): AccountView {
  return {
    id,
    label: `claude ${id}`,
    provider: "anthropic-oauth",
    status: "active",
    hasCredential: false,
    configDir: `/data/claude/${id}`,
    baseUrl: null,
    dialect: "anthropic",
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 100,
    priority: 0,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    credential: cred,
  }
}

const ESTIMATED = sub(
  "est",
  credential({
    renewsAt: new Date(NOW + 3 * DAY + 3_600_000).toISOString(),
    renewsAtSource: "estimated",
    daysUntilRenewal: 3,
    renewalRequiredSoon: true,
  }),
)
const REPORTED = sub(
  "rep",
  credential({
    expiresAt: new Date(NOW + 20 * DAY).toISOString(),
    renewsAt: new Date(NOW + 20 * DAY).toISOString(),
    renewsAtSource: "reported",
    daysUntilRenewal: 20,
  }),
)

function mount(view: () => JSX.Element, run: (container: HTMLElement) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(view, container)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("login lifetime in the console", () => {
  test("the row cell says when the login renews and how the router knows", () => {
    mount(
      () => (
        <CredentialCell
          account={ESTIMATED}
          nowMs={NOW}
          onReconnect={() => {}}
          provider={undefined}
        />
      ),
      (container) => {
        expect(container.textContent).toContain("Login renews in 3 days (estimated)")
      },
    )
    mount(
      () => (
        <CredentialCell
          account={REPORTED}
          nowMs={NOW}
          onReconnect={() => {}}
          provider={undefined}
        />
      ),
      (container) => {
        expect(container.textContent).toContain("Login renews in 20 days (reported)")
      },
    )
  })

  test("the account dialog spells out both clocks", () => {
    mount(
      () => <LoginLifetimeSummary account={ESTIMATED} nowMs={NOW} />,
      (container) => {
        expect(container.textContent).toContain("Login renews in 3 days (estimated)")
        expect(container.textContent).toContain("Last interactive login")
        expect(container.textContent).toContain("Access token refreshes")
      },
    )
  })

  test("the banner names the server's warn window, not a hard-coded week", () => {
    mount(
      () => <SubscriptionBanner accounts={[ESTIMATED, REPORTED]} nowMs={NOW} />,
      (container) => {
        expect(container.textContent).toContain("1 Claude subscription expires within 5 days")
        expect(container.textContent).toContain("claude est")
        expect(container.textContent).not.toContain("claude rep")
      },
    )
  })

  test("Reconnect expiring hands exactly the expiring accounts to the reconnect sequence", () => {
    const dead = { ...sub("dead", credential({ present: false })) }
    const health = summarizeSubscriptions([ESTIMATED, REPORTED, dead], NOW)
    const queues: string[][] = []
    mount(
      () => (
        <ReconnectActions
          health={health}
          onReconnect={(queue) => queues.push(queue.map((a) => a.id))}
        />
      ),
      (container) => {
        const buttons = [...container.querySelectorAll("button")]
        expect(buttons.map((b) => b.textContent)).toEqual([
          "Reconnect all (1)",
          "Reconnect expiring (1)",
        ])
        buttons[1]?.click()
        buttons[0]?.click()
      },
    )
    expect(queues).toEqual([["est"], ["dead"]])
  })

  test("nothing expiring, no Reconnect expiring button", () => {
    const health = summarizeSubscriptions([REPORTED], NOW)
    mount(
      () => <ReconnectActions health={health} onReconnect={() => {}} />,
      (container) => {
        expect(container.querySelectorAll("button")).toHaveLength(0)
      },
    )
  })
})
