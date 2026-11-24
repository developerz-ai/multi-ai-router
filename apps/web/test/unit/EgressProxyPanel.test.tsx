import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import type { AccountView } from "../../src/lib/api/types"
import { AccountEditDialog } from "../../src/routes/accounts/AccountEditDialog"
import { EgressProxyPanel } from "../../src/routes/accounts/EgressProxyPanel"
import { base as editDialog } from "../support/account-edit"
import { fire, selectOption, typeInto } from "../support/dom"
import { assignment, overview } from "../support/egress"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 25))
const account = (egressProxy: string | null) =>
  ({ id: "a", label: "or-main", egressProxy }) as AccountView

async function mount(
  row: AccountView,
  shown: boolean,
  run: (root: HTMLElement, calls: string[]) => void | Promise<void>,
  held = assignment({ id: "a" }),
  client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } }),
  saved: Promise<void> = Promise.resolve(),
) {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if (init?.method !== undefined && init.method !== "GET") {
      calls.push(`${init.method} ${url.replace("/api/admin", "")} ${init.body ?? ""}`.trim())
      if (!url.endsWith("/test")) await saved
      return url.endsWith("/test")
        ? Response.json({
            outcome: "auth",
            status: 407,
            latencyMs: 12,
            checkedAt: new Date().toISOString(),
            nextAllowedAt: new Date(Date.now() + 60_000).toISOString(),
          })
        : Response.json({ id: "a", egressProxy: "203.0.113.7:6754" })
    }
    return Response.json(overview())
  }) as typeof fetch
  const root = document.createElement("div")
  document.body.appendChild(root)
  client.setQueryData(["egress-proxies"], overview({ assigned: [held] }))
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <EgressProxyPanel account={row} shown={shown} />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await run(root, calls)
  } finally {
    dispose()
    root.remove()
  }
}

const open = (root: HTMLElement) => fire(root.querySelector("button") as HTMLButtonElement, "click")
const urlBox = (root: HTMLElement) => root.querySelector("input") as HTMLInputElement
const selectWith = (root: HTMLElement, value: string) =>
  [...root.querySelectorAll("select")].find((node) =>
    [...node.options].some((option) => option.value === value),
  ) as HTMLSelectElement
const press = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll("button")].find((node) => node.textContent === label)?.click()

test("a provider that signs in shows nothing: the API refuses it a proxy", () =>
  mount(account(null), false, (root) => expect(root.textContent).toBe("")))

test("the stored proxy is shown as host and port, and the box opens empty", () =>
  mount(account("p.test:8080"), true, (root) => {
    expect(root.textContent).toContain("p.test:8080")
    open(root)
    expect(urlBox(root).value).toBe("")
    expect(root.textContent).toContain("Remove proxy")
    expect(root.textContent).toContain("203.0.113.7:6754 Buffalo, US")
  }))

test("with none set there is nothing to remove", () =>
  mount(account(null), true, (root) => {
    expect(root.textContent).toContain("none, direct")
    open(root)
    expect(root.textContent).not.toContain("Remove proxy")
  }))

test("Enter in the URL box saves the proxy: the editor is its own form", () =>
  mount(account(null), true, async (root, calls) => {
    open(root)
    typeInto(urlBox(root), "http://u:p@p.test:8080")
    const form = urlBox(root).form
    expect(form?.querySelector('button[type="submit"]')?.textContent).toBe("Set proxy")
    if (form !== null) fire(form, "submit")
    await settle()
    expect(calls).toEqual(['PATCH /egress-proxies/accounts/a {"url":"http://u:p@p.test:8080"}'])
  }))

test("a vendor proxy is set with its replacement mode, and a typed one without", () =>
  mount(account(null), true, async (root, calls) => {
    open(root)
    selectOption(selectWith(root, "webshare/d-1"), "webshare/d-1")
    const modes = [...root.querySelectorAll("select")].filter((node) =>
      [...node.options].some((option) => option.value === "on-failure"),
    )
    selectOption(modes.at(-1) as HTMLSelectElement, "on-failure")
    press(root, "Set proxy")
    const form = urlBox(root).form
    if (form !== null) fire(form, "submit")
    await settle()
    expect(calls[0]).toBe(
      'PATCH /egress-proxies/accounts/a {"vendor":"webshare","id":"d-1","replace":"on-failure"}',
    )
  }))

test("a proxy can be tested before it is set, and the answer is said in words", () =>
  mount(account(null), true, async (root, calls) => {
    open(root)
    typeInto(urlBox(root), "http://u:p@p.test:8080")
    press(root, "Test now")
    await settle()
    expect(calls).toEqual([
      'POST /egress-proxies/test {"url":"http://u:p@p.test:8080","accountId":"a"}',
    ])
    expect(root.textContent).toContain("login refused")
    typeInto(urlBox(root), "http://other.test:1")
    expect(root.querySelector('[role="status"]')?.textContent).toBe("")
  }))

test("choosing another proxy sends no mode: the router keeps the stored one", () =>
  mount(
    account("203.0.113.7:6754"),
    true,
    async (root, calls) => {
      open(root)
      selectOption(selectWith(root, "webshare/d-1"), "webshare/d-1")
      const form = urlBox(root).form
      if (form !== null) fire(form, "submit")
      await settle()
      expect(calls[0]).toBe('PATCH /egress-proxies/accounts/a {"vendor":"webshare","id":"d-1"}')
    },
    assignment({ id: "a", replace: "on-failure" }),
  ))

test("a saved proxy URL is not kept by the mutation that sent it", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } })
  const variables = () =>
    JSON.stringify(
      client
        .getMutationCache()
        .getAll()
        .map((one) => one.state.variables),
    )
  const gate = Promise.withResolvers<void>()
  await mount(
    account(null),
    true,
    async (root, calls) => {
      open(root)
      typeInto(urlBox(root), "http://u:hunter2@p.test:8080")
      const form = urlBox(root).form
      if (form !== null) fire(form, "submit")
      await settle()
      expect(calls).toHaveLength(1)
      expect(variables()).toContain("hunter2")
      gate.resolve()
      await settle()
      await settle()
      expect(variables()).not.toContain("hunter2")
    },
    assignment({ id: "a" }),
    client,
    gate.promise,
  )
})

test("a save clears the draft it sent, not one typed while it was in flight", async () => {
  const gate = Promise.withResolvers<void>()
  await mount(
    account(null),
    true,
    async (root) => {
      open(root)
      typeInto(urlBox(root), "http://u:p@first.test:1")
      const form = urlBox(root).form
      if (form !== null) fire(form, "submit")
      await settle()
      typeInto(urlBox(root), "http://u:p@second.test:2")
      gate.resolve()
      await settle()
      expect(urlBox(root).value).toBe("http://u:p@second.test:2")
    },
    assignment({ id: "a" }),
    new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } }),
    gate.promise,
  )
})

test("inside the account dialog, the proxy box submits the proxy and never the account", async () => {
  const calls: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes("/auth/session")) return Response.json({ username: "a", csrfToken: "t" })
    if ((init?.method ?? "GET") !== "GET") calls.push(`${init?.method} ${url}`)
    return Response.json(url.includes("/accounts/") ? { id: "a", egressProxy: null } : overview())
  }) as typeof fetch
  let accountSaves = 0
  const dispose = render(
    () => (
      <QueryClientProvider client={new QueryClient()}>
        <AccountEditDialog {...editDialog({ onSubmit: () => (accountSaves += 1) })} />
      </QueryClientProvider>
    ),
    document.body,
  )
  try {
    const change = [...document.querySelectorAll("button")].find(
      (node) => node.textContent === "Change egress proxy",
    )
    change?.click()
    await settle()
    const label = [...document.querySelectorAll("label")].find((node) =>
      node.textContent?.startsWith("Proxy URL"),
    )
    const box = document.getElementById(label?.htmlFor ?? "") as HTMLInputElement
    typeInto(box, "http://u:p@p.test:8080")
    // What Enter submits is the field's form owner, and nothing above it may be a form too.
    expect(box.form?.id).not.toBe("account-edit-form")
    expect(box.form?.parentElement?.closest("form")).toBeNull()
    box.form?.requestSubmit()
    await settle()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("/egress-proxies/accounts/")
    expect(accountSaves).toBe(0)
  } finally {
    dispose()
  }
})
