import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView, ApiKeyView, PoolView } from "../../src/lib/api/types"
import { OnboardingPanel } from "../../src/routes/overview/OnboardingPanel"

/**
 * The three creation dialogs this panel mounts (`AccountFormDialog`, `PoolFormDialog`,
 * `KeyFormDialog`, plus `AccountConnect`) all start closed and render through `Modal`'s `Portal` —
 * so a real submit-and-mint round trip is out of scope here (it would need a mocked `fetch`, which
 * nothing in this console's test suite does yet). What is asserted instead is the one thing that
 * is pure DOM state driven entirely by props: which step reads as done, which is next, and that the
 * whole panel retires once the walk is actually finished.
 *
 * `container` is queried directly and removed after, same reasoning as `AccountsTable.test.tsx` —
 * `happy-dom`'s `document` is one global shared across every test file in this process.
 */
function withMount(
  props: Parameters<typeof OnboardingPanel>[0],
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const queryClient = new QueryClient()
  const dispose = render(
    () => (
      <QueryClientProvider client={queryClient}>
        <OnboardingPanel {...props} />
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

function account(overrides: Partial<AccountView> = {}): AccountView {
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
    weight: 1,
    priority: 0,
    tokenExpiresAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function pool(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: "pool-1",
    name: "claude-pool",
    policy: "sticky",
    overflowAccountId: null,
    members: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: "key-1",
    name: "ci-runner",
    prefix: "mar_live_ab12",
    scope: { kind: "all", poolIds: [], accountIds: [] },
    rateLimit: null,
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((el) => el.textContent === label)
}

describe("OnboardingPanel", () => {
  test("on a fresh deployment, shows all three steps with only the first one actionable", () => {
    withMount(
      { accounts: [], pools: [], keys: [], providers: [], publicUrl: null },
      (container) => {
        expect(container.textContent).toContain("Get your first working key")
        expect(container.textContent).toContain("Add an account")
        expect(container.textContent).toContain("Create a pool")
        expect(container.textContent).toContain("Mint a key")

        expect(button(container, "Add account")?.disabled).toBe(false)
        expect(button(container, "New pool")?.disabled).toBe(true)
        expect(button(container, "Mint key")?.disabled).toBe(true)
      },
    )
  })

  test("marks a finished step done, by name, and unlocks the next one", () => {
    withMount(
      { accounts: [account()], pools: [], keys: [], providers: [], publicUrl: null },
      (container) => {
        expect(container.textContent).toContain('"prod-claude-1" added')
        expect(container.querySelector("button")?.textContent).not.toBe("Add account")

        expect(button(container, "New pool")?.disabled).toBe(false)
        expect(button(container, "Mint key")?.disabled).toBe(true)
      },
    )
  })

  test("names the count once several accounts exist, rather than one label", () => {
    withMount(
      {
        accounts: [account({ id: "a" }), account({ id: "b", label: "prod-claude-2" })],
        pools: [],
        keys: [],
        providers: [],
        publicUrl: null,
      },
      (container) => {
        expect(container.textContent).toContain("2 accounts added")
      },
    )
  })

  test("unlocks minting only once a pool exists", () => {
    withMount(
      { accounts: [account()], pools: [pool()], keys: [], providers: [], publicUrl: null },
      (container) => {
        expect(container.textContent).toContain('"claude-pool" created')
        expect(button(container, "Mint key")?.disabled).toBe(false)
      },
    )
  })

  test("retires the whole panel once an account, a pool and a key all exist", () => {
    withMount(
      { accounts: [account()], pools: [pool()], keys: [key()], providers: [], publicUrl: null },
      (container) => {
        expect(container.textContent).toBe("")
        expect(container.querySelector("button")).toBeNull()
      },
    )
  })
})
