import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { RecheckResult, TestNowResult } from "../../src/lib/api/accounts"
import type { AccountView, ProviderDescriptor } from "../../src/lib/api/types"
import { queryKeys } from "../../src/lib/queries/query-keys"
import { AccountEditDialog } from "../../src/routes/accounts/AccountEditDialog"
import { AccountModels } from "../../src/routes/accounts/AccountModels"
import { AccountRecheck } from "../../src/routes/accounts/AccountRecheck"
import { AccountTestNow } from "../../src/routes/accounts/AccountTestNow"
import { ConnectResult } from "../../src/routes/accounts/ConnectResult"

/**
 * WCAG 4.1.3 regression coverage for the button-press outcomes on the accounts
 * surface (audit 2026-07-30, HIGH #3/#4/#5): a `role="status"` inserted into
 * the DOM together with its own text announces unreliably, so each control
 * renders its live region on mount and swaps the outcome inside it. These
 * tests assert exactly that ordering — region present before there is anything
 * to announce, outcome inside the region once there is.
 *
 * `container` is queried directly and removed after, rather than
 * `document.body` — happy-dom's `document` is one global shared by every test
 * file in this process.
 */
function withMount(render_: () => JSX.Element, run: (container: HTMLElement) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(render_, container)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

const statusRegion = (container: HTMLElement): HTMLElement => {
  const region = container.querySelector('[role="status"]')
  if (!(region instanceof HTMLElement)) throw new Error("no pre-mounted role=status region")
  return region
}

const NOW_MS = Date.parse("2026-07-31T12:00:00.000Z")

describe("AccountRecheck live region", () => {
  const mount = (client: QueryClient, run: (container: HTMLElement) => void): void =>
    withMount(
      () => (
        <QueryClientProvider client={client}>
          <AccountRecheck
            accountId="acc-1"
            busy={false}
            lastCheckedAt={null}
            nowMs={NOW_MS}
            onRecheck={() => {}}
          />
        </QueryClientProvider>
      ),
      run,
    )

  test("the status region is mounted before any press, carrying the idle line", () => {
    mount(new QueryClient(), (container) => {
      expect(statusRegion(container).textContent).toContain("Not checked since restart")
    })
  })

  test("a press outcome lands inside the already-mounted region", () => {
    const client = new QueryClient()
    const result: RecheckResult = {
      accountId: "acc-1",
      lastCheckedAt: "2026-07-31T11:58:00.000Z",
      nextAllowedAt: "2026-07-31T12:03:00.000Z",
      rechecked: false,
    }
    client.setQueryData(queryKeys.accounts.recheck("acc-1"), result)
    mount(client, (container) => {
      const region = statusRegion(container)
      expect(region.textContent).toContain("On cooldown")
      expect(region.textContent).toContain("Checked")
    })
  })
})

describe("AccountTestNow live region", () => {
  const mount = (client: QueryClient, run: (container: HTMLElement) => void): void =>
    withMount(
      () => (
        <QueryClientProvider client={client}>
          <AccountTestNow
            accountId="acc-1"
            busy={false}
            nowMs={NOW_MS}
            onTest={() => {}}
            transport="http"
          />
        </QueryClientProvider>
      ),
      run,
    )

  test("the status region is mounted before any test run, and empty", () => {
    mount(new QueryClient(), (container) => {
      expect(statusRegion(container).textContent).toBe("")
    })
  })

  test("a test outcome lands inside the already-mounted region", () => {
    const client = new QueryClient()
    const result: TestNowResult = {
      accountId: "acc-1",
      lastCheckedAt: "2026-07-31T11:59:00.000Z",
      nextAllowedAt: "2026-07-31T12:05:00.000Z",
      tested: true,
      outcome: "ok",
      message: "pong",
    }
    client.setQueryData(queryKeys.accounts.test("acc-1"), result)
    mount(client, (container) => {
      const region = statusRegion(container)
      expect(region.textContent).toContain("Answered")
      expect(region.textContent).toContain("pong")
    })
  })
})

describe("AccountModels live region", () => {
  const mount = (models: readonly string[] | null, run: (container: HTMLElement) => void): void =>
    withMount(
      () => (
        <AccountModels
          accountId="acc-1"
          busy={false}
          models={models}
          onDiscover={() => {}}
          transport="http"
        />
      ),
      run,
    )

  test("the status region is mounted on the empty state, before any discovery", () => {
    mount(null, (container) => {
      expect(statusRegion(container).textContent).toContain("any model")
    })
  })

  test("a discovery result — badge and preview — renders inside the region", () => {
    mount(["glm-4.6", "glm-4.7"], (container) => {
      const region = statusRegion(container)
      expect(region.textContent).toContain("2 models")
      expect(region.textContent).toContain("glm-4.6, glm-4.7")
    })
  })
})

describe("ConnectResult live region", () => {
  test("the region is mounted before completion and truly empty, so :empty gates the visual", () => {
    // The scss hides the pre-completion box with `.success:empty` — that selector only
    // matches if Solid leaves the section with no child nodes at all, which this pins.
    withMount(
      () => <ConnectResult completed={null} mode="connect" />,
      (container) => {
        const region = statusRegion(container)
        expect(region.childNodes.length).toBe(0)
      },
    )
  })

  test("a completion announces inside the already-mounted region", () => {
    withMount(
      () => (
        <ConnectResult
          completed={{ accountId: "acc-1", mode: "connect", connected: true }}
          mode="connect"
        />
      ),
      (container) => {
        expect(statusRegion(container).textContent).toContain("Connected.")
      },
    )
  })
})

describe("AccountEditDialog numeric guard", () => {
  const PROVIDER: ProviderDescriptor = {
    id: "zai",
    transport: "http",
    authKind: "api-key",
    nativeDialect: "anthropic",
    supportedDialects: ["anthropic"],
    requiresBaseUrl: false,
    requiresConfigDir: false,
    connectFlow: null,
    creatable: true,
    reason: null,
    defaultBilling: "metered",
    billingFixed: false,
  }

  const ACCOUNT: AccountView = {
    id: "acc-1",
    label: "zai-primary",
    provider: "zai",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    weight: 300,
    priority: 2,
    billing: "metered",
    tokenExpiresAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  }

  const fieldByLabel = (text: string): HTMLInputElement => {
    const label = Array.from(document.querySelectorAll("label")).find(
      (element) => element.textContent?.trim().startsWith(text) === true,
    )
    const input = label === undefined ? null : document.getElementById(label.htmlFor)
    if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled "${text}"`)
    return input
  }

  test("weight and priority refuse an empty or out-of-range box natively, so no fallback exists", () => {
    // The submit-time NaN fallback was deleted as unreachable (audit 2026-07-30, HIGH #7):
    // `required` + `type="number"` + `min`/`max` block the invalid submit before the handler
    // runs, matching the API's `z.number().int().min(1)`. These attributes are the whole
    // contract now, so they are what gets asserted.
    withMount(
      () => (
        <AccountEditDialog
          account={ACCOUNT}
          busy={false}
          error={null}
          onClose={() => {}}
          onSubmit={() => {}}
          open
          provider={PROVIDER}
        />
      ),
      () => {
        for (const [name, min] of [
          ["Weight", "1"],
          ["Priority", "0"],
        ] as const) {
          const input = fieldByLabel(name)
          expect(input.required).toBe(true)
          expect(input.type).toBe("number")
          expect(input.min).toBe(min)
        }
      },
    )
  })
})
