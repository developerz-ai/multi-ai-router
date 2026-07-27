import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { AccountView, ApiKeyView, PoolView } from "../../src/lib/api/types"
import { OnboardingPanel } from "../../src/routes/overview/OnboardingPanel"
import { fire, typeInto } from "../support/dom"

const PLAINTEXT = "mar_live_9f2c4d6e8a0b2c4d6e8a0b2c"
const PUBLIC_URL = "https://router.example.com"

/**
 * The walk from an empty deployment to a key a tool can use.
 *
 * Most of this is pure DOM state driven by props — which step reads as done, which is next, that
 * the panel retires once the walk is finished — and is asserted by mounting and reading.
 *
 * The mint is not. Its payoff is the **fourth** step of the product story, the one where an
 * operator who has never seen this router before finds out where to paste what, so it is driven
 * end to end against a stubbed `fetch`: click through the real `KeyFormDialog`, and assert the
 * value lands in the same **Point your tool at it** panel `KeysRoute` shows — carrying the `/v1`
 * suffix rule, which is the single thing about pointing a client here that is easy to get wrong.
 *
 * `container` is queried directly and removed after, same reasoning as `AccountsTable.test.tsx` —
 * `happy-dom`'s `document` is one global shared across every test file in this process. Anything
 * rendered through `Modal`'s `Portal` lands on `document.body` instead, so dialog assertions read
 * from there.
 */
interface Mounted {
  readonly container: HTMLElement
  readonly client: QueryClient
  readonly dispose: () => void
}

function mount(props: Parameters<typeof OnboardingPanel>[0]): Mounted {
  const container = document.createElement("div")
  document.body.appendChild(container)
  // No retries: a stubbed response that does not parse should fail the test, not be quietly
  // attempted three more times.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <OnboardingPanel {...props} />
      </QueryClientProvider>
    ),
    container,
  )
  return { container, client, dispose }
}

function withMount(
  props: Parameters<typeof OnboardingPanel>[0],
  run: (container: HTMLElement) => void,
): void {
  const { container, dispose } = mount(props)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function stubFetch(calls: string[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString()
    const method = init?.method ?? "GET"
    calls.push(`${method} ${url}`)
    const body = url.endsWith("/keys") && method === "POST" ? { ...key(), value: PLAINTEXT } : []
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

/** Every plaintext the query client is holding anywhere, query or mutation cache. */
function cachedState(client: QueryClient): string {
  return JSON.stringify([
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state),
    client
      .getQueryCache()
      .getAll()
      .map((query) => query.state.data),
  ])
}

/** Solid renders synchronously; what is awaited here is the stubbed round trip. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function bodyButton(label: string): HTMLButtonElement {
  const found = Array.from(document.body.querySelectorAll("button")).find(
    (element) => element.textContent?.trim() === label,
  )
  if (!(found instanceof HTMLButtonElement)) throw new Error(`no button labelled "${label}"`)
  return found
}

/** Control ids are generated, so a field is found the way an operator does: by its label. */
function fieldLabelled(text: string): HTMLInputElement {
  const label = Array.from(document.body.querySelectorAll("label")).find((element) =>
    element.textContent?.trim().startsWith(text),
  )
  const input =
    label === null || label === undefined ? null : document.getElementById(label.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled "${text}"`)
  return input
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

describe("OnboardingPanel, minting the first key", () => {
  const ready = {
    accounts: [account()],
    pools: [pool()],
    keys: [] as readonly ApiKeyView[],
    providers: [],
    publicUrl: PUBLIC_URL,
  }

  async function mintFirstKey(): Promise<Mounted & { readonly calls: string[] }> {
    const calls: string[] = []
    stubFetch(calls)
    const mounted = mount(ready)
    bodyButton("Mint key").click()
    typeInto(fieldLabelled("Name"), "ci-runner")
    const form = document.body.querySelector("form")
    if (form === null) throw new Error("mint form not rendered")
    fire(form, "submit")
    await settle()
    return { ...mounted, calls }
  }

  test("ends the walk on the same 'Point your tool at it' panel the keys screen shows", async () => {
    const { calls, container, dispose } = await mintFirstKey()
    try {
      expect(calls).toContain("POST /api/admin/keys")

      const shown = document.body.textContent ?? ""
      expect(shown).toContain("Point your tool at it")
      // The suffix rule, both directions, pre-filled with this deployment's own address: an
      // Anthropic-dialect client appends `/v1/messages` and gets the bare origin, an OpenAI one
      // appends `/chat/completions` and must be handed the `/v1` already.
      expect(shown).toContain(`export ANTHROPIC_BASE_URL="${PUBLIC_URL}"`)
      expect(shown).toContain(`export ANTHROPIC_AUTH_TOKEN="${PLAINTEXT}"`)
      bodyButton("Cursor").click()
      expect(document.body.textContent).toContain(`${PUBLIC_URL}/v1`)

      // Not a shown-once flow, and the dialog must not imply one.
      expect(shown).toContain("Nothing here is shown once")

      // The keys query the mint invalidated has no observer here, so `props.keys` is still empty:
      // the step must read off the value in hand rather than re-offering a button that would mint
      // a second key over the top of one the operator has not copied yet.
      expect(container.textContent).toContain('"ci-runner" minted')
      expect(
        Array.from(container.querySelectorAll("button")).map((element) => element.textContent),
      ).not.toContain("Mint key")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("never parks the minted value in the query client, and drops it on dismiss", async () => {
    const { client, container, dispose } = await mintFirstKey()
    try {
      // On screen — so the assertions below are about a value that genuinely existed, not a round
      // trip that quietly never happened.
      expect(document.body.textContent).toContain(PLAINTEXT)
      // …and even while it is on screen it is held only by the panel's own signal. The mint is
      // reset the moment its value is in hand, so TanStack's mutation cache never holds a live
      // credential for its `gcTime` the way an unreset one would.
      expect(cachedState(client)).not.toContain(PLAINTEXT)

      bodyButton("Done").click()
      await settle()

      expect(document.body.textContent).not.toContain(PLAINTEXT)
      expect(cachedState(client)).not.toContain(PLAINTEXT)
    } finally {
      dispose()
      container.remove()
    }
  })
})
