import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView, ProviderDescriptor } from "../../src/lib/api/types"
import { NO_USAGE } from "../../src/lib/usage-index"
import { AccountsTable } from "../../src/routes/accounts/AccountsTable"

const PROVIDER: ProviderDescriptor = {
  id: "anthropic",
  transport: "http",
  authKind: "api_key",
  nativeDialect: "anthropic",
  supportedDialects: ["anthropic"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
}

function account(overrides: Partial<AccountView>): AccountView {
  return {
    id: "acc-1",
    label: "prod-claude-1",
    provider: "anthropic",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: "anthropic",
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 0,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * `AccountRecheck` (rendered in every row, "Re-check" column) reads
 * `useLastRecheck`, a TanStack Query hook — needs a real `QueryClientProvider`
 * ancestor or it throws before the row ever paints, same as it would in the
 * app.
 *
 * `container` is queried directly and removed after, rather than
 * `document.body` — `happy-dom`'s `document` is one global shared by every
 * test file in this process.
 */
function withMount(
  accounts: readonly AccountView[],
  overrides: Partial<Parameters<typeof AccountsTable>[0]>,
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const queryClient = new QueryClient()
  const dispose = render(
    () => (
      <QueryClientProvider client={queryClient}>
        <AccountsTable
          accounts={accounts}
          nowMs={Date.parse("2026-07-26T00:00:00.000Z")}
          discoveringId={null}
          onConnect={() => {}}
          onDelete={() => {}}
          onDisable={() => {}}
          onDiscoverModels={() => {}}
          onEdit={() => {}}
          onEnable={() => {}}
          onRecheck={() => {}}
          onTest={() => {}}
          providerFor={() => PROVIDER}
          recheckingId={null}
          testingId={null}
          usage={new Map()}
          usageBucket="day"
          usageLoading={false}
          usageWindowLabel="7d"
          {...overrides}
        />
      </QueryClientProvider>
    ),
    container,
  )
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("AccountsTable", () => {
  test("an exhausted account reads needs top-up, never a countdown", () => {
    withMount(
      [
        account({
          id: "acc-exhausted",
          label: "prod-claude-1",
          status: "exhausted",
          availability: {
            configuredStatus: "exhausted",
            resetsAt: "2026-07-27T00:00:00.000Z",
            resetSource: "reported",
            lastCheckedAt: "2026-07-26T00:00:00.000Z",
            consecutiveFailures: 0,
            inFlight: 0,
          },
        }),
      ],
      {},
      (container) => {
        expect(container.textContent).toContain("Needs top-up")
        // A countdown/absolute-time span never renders alongside "needs
        // top-up" — it is the one status `describeReset` refuses a clock
        // reading for.
        expect(container.querySelector('[data-kind="needs_topup"]')).not.toBeNull()
        expect(container.querySelectorAll("[class*='absolute']").length).toBe(0)
      },
    )
  })

  test("an active account with a reset shows the absolute time, not needs top-up", () => {
    withMount(
      [
        account({
          status: "cooling_down",
          availability: {
            configuredStatus: "cooling_down",
            resetsAt: "2026-07-26T01:00:00.000Z",
            resetSource: "reported",
            lastCheckedAt: "2026-07-26T00:00:00.000Z",
            consecutiveFailures: 1,
            inFlight: 0,
          },
        }),
      ],
      {},
      (container) => {
        expect(container.textContent).not.toContain("Needs top-up")
        expect(container.querySelector('[data-kind="needs_topup"]')).toBeNull()
      },
    )
  })

  test("renders one row per account, identified by label", () => {
    withMount(
      [
        account({ id: "a", label: "acc-a" }),
        account({ id: "b", label: "acc-b", status: "disabled" }),
      ],
      {},
      (container) => {
        expect(container.textContent).toContain("acc-a")
        expect(container.textContent).toContain("acc-b")
        expect(container.querySelectorAll("tbody tr").length).toBe(2)
      },
    )
  })

  test("every row offers an edit action and hands back the account it belongs to", () => {
    // Without this the only way to change a label, rotate a credential or retune an
    // account's weight is a delete and re-add, which takes its history with it.
    let edited: AccountView | undefined
    withMount(
      [account({ id: "a", label: "acc-a" }), account({ id: "b", label: "acc-b" })],
      { onEdit: (target) => (edited = target) },
      (container) => {
        const buttons = Array.from(container.querySelectorAll("tbody button")).filter(
          (button) => button.textContent?.trim() === "Edit",
        )
        expect(buttons.length).toBe(2)

        const second = buttons[1]
        if (!(second instanceof HTMLButtonElement)) throw new Error("no edit button")
        second.click()
        expect(edited?.id).toBe("b")
      },
    )
  })

  test("a never-used account reads the word never, not a blank and not a time", () => {
    // NULL was the fleet-wide state of last_used_at from 1.2.0 until the 2.4.0 stamping fix —
    // this cell is how an operator confirms the fix landed and spots a pooled-but-never-selected
    // account without a database shell.
    withMount([account({ lastUsedAt: null })], {}, (container) => {
      expect(container.textContent).toContain("used never")
      expect(container.textContent).not.toContain("Invalid Date")
    })
  })

  test("a stamped account shows relative last use", () => {
    // nowMs is 2026-07-26T00:00Z; one hour earlier renders as an hour ago.
    withMount([account({ lastUsedAt: "2026-07-25T23:00:00.000Z" })], {}, (container) => {
      expect(container.textContent).toContain("used 1h ago")
    })
  })

  test("an active account with a spent window says so at headline level", () => {
    // Status stays `active` — filtering drops the account anyway (quota-window-spent). Without
    // this line the only truth is a badge buried in the window sub-row.
    withMount(
      [
        account({
          availability: {
            configuredStatus: "active",
            resetsAt: null,
            resetSource: "unknown",
            lastCheckedAt: null,
            consecutiveFailures: 0,
            inFlight: 0,
            quotaWindows: [
              {
                window: "five_hour",
                utilization: 1,
                utilizationSource: "threshold-triggered",
                resetsAt: "2026-07-26T00:40:00.000Z",
                resetSource: "provider-reported",
                lastCheckedAt: "2026-07-25T23:59:00.000Z",
                spent: true,
                tokensUsed: null,
                tokenLimit: null,
              },
            ],
          },
        }),
      ],
      {},
      (container) => {
        expect(container.textContent).toContain("window spent — not routable")
      },
    )
  })

  test("no spent-window line without a spent window", () => {
    withMount([account({})], {}, (container) => {
      expect(container.textContent).not.toContain("window spent")
    })
  })

  test("a malformed reset instant never renders as Invalid Date or a zero countdown", () => {
    withMount(
      [
        account({
          status: "cooling_down",
          availability: {
            configuredStatus: "cooling_down",
            resetsAt: "not-an-instant",
            resetSource: "provider-reported",
            lastCheckedAt: null,
            consecutiveFailures: 1,
            inFlight: 0,
          },
        }),
      ],
      {},
      (container) => {
        expect(container.textContent).not.toContain("Invalid Date")
        expect(container.textContent).not.toContain("in 0s")
      },
    )
  })

  test("an unknown-source reset prints no absolute timestamp beside its own admission", () => {
    // "Unknown — …" beside a printed clock time contradicts itself; the instant travels only
    // with the countdown and due kinds, matching describeQuotaWindow's discipline.
    withMount(
      [
        account({
          status: "cooling_down",
          availability: {
            configuredStatus: "cooling_down",
            resetsAt: "2026-07-26T01:00:00.000Z",
            resetSource: "unknown",
            lastCheckedAt: null,
            consecutiveFailures: 1,
            inFlight: 0,
          },
        }),
      ],
      {},
      (container) => {
        expect(container.textContent).toContain("Unknown")
        expect(container.querySelectorAll("[class*='absolute']").length).toBe(0)
      },
    )
  })

  test("usage cell renders a dash while loading, never a zero", () => {
    withMount(
      [account({})],
      { usage: new Map([["acc-1", NO_USAGE]]), usageLoading: true, usageWindowLabel: "today" },
      (container) => {
        expect(container.textContent).toContain("—")
        expect(container.textContent ?? "").not.toMatch(/\b0 req/)
      },
    )
  })
})
