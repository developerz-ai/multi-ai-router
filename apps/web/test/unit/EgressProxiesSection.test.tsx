import { afterEach, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import { clearSession } from "../../src/lib/api/session"
import { outcomeBadge } from "../../src/routes/egress/egress-copy"
import { EgressProxiesSection } from "../../src/routes/settings/EgressProxiesSection"
import { selectOption } from "../support/dom"
import { assignment, overview } from "../support/egress"
import { settle, withSection } from "../support/egress-section"

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  clearSession()
})

const modeSelect = (root: HTMLElement) =>
  root.querySelector('select[aria-label="If the proxy of or-main dies"]') as HTMLSelectElement

test("says what on-failure does and what it never does", () =>
  withSection(overview(), (root) => {
    expect(root.textContent).toContain("another one of the same vendor")
    expect(root.textContent).toContain("never reads an AI provider's answer")
    expect(root.textContent).toContain("never rotates addresses")
    expect(root.textContent).toContain("No account uses a proxy")
  }))

test("a dead proxy with no replacement is a red banner and a reason on its row", () =>
  withSection(
    overview({
      assigned: [
        assignment({
          replace: "on-failure",
          healthOf: { outcome: "unreachable", consecutiveFailures: 4, repair: "no_candidate" },
        }),
      ],
    }),
    (root) => {
      expect(root.textContent).toContain("1 dead proxy was not replaced")
      expect(root.textContent).toContain("4 failed checks in a row")
      expect(root.textContent).toContain("no unused healthy proxy")
    },
  ))

test("a refused target is not a dead proxy", () => {
  expect(outcomeBadge("refused").tone).toBe("warn")
  expect(outcomeBadge("refused").hint).toContain("never replaced for it")
  expect(outcomeBadge(null).label).toBe("not checked")
})

test("the mode is saved on change", () =>
  withSection(overview({ assigned: [assignment()] }), async (root, calls) => {
    selectOption(modeSelect(root), "on-failure")
    await settle()
    expect(calls).toEqual(['PATCH /egress-proxies/accounts/a/replace {"replace":"on-failure"}'])
  }))

test("a refused mode goes back to the stored one and says why", () =>
  withSection(
    overview({ assigned: [assignment()] }),
    async (root) => {
      selectOption(modeSelect(root), "on-failure")
      await settle()
      expect(modeSelect(root).value).toBe("manual")
      expect(root.textContent).toContain("only a vendor proxy")
    },
    () => Response.json({ error: { message: "only a vendor proxy" } }, { status: 400 }),
  ))

test("a proxy typed in by hand has no mode to choose", () =>
  withSection(
    overview({
      assigned: [
        assignment({
          vendor: null,
          vendorId: null,
          address: "p.test:1",
          listed: null,
          valid: null,
        }),
      ],
    }),
    (root) => {
      expect(modeSelect(root).disabled).toBe(true)
      expect(root.textContent).toContain("custom")
    },
  ))

test("an unreadable vendor list is said, and is not an empty inventory", () =>
  withSection(
    overview({
      proxies: [],
      vendors: [
        {
          vendor: "webshare",
          state: "unavailable",
          complete: false,
          error: { code: "timeout", message: "webshare did not answer in time" },
        },
      ],
    }),
    (root) => {
      expect(root.textContent).toContain(
        "webshare did not answer in time, so its list is missing here and no proxy is replaced.",
      )
    },
  ))

test("a proxy the vendor places nowhere reads without a dangling separator", () => {
  const [listed] = overview().proxies
  if (listed === undefined) throw new Error("fixture lists no proxy")
  return withSection(
    overview({ proxies: [{ ...listed, location: "", country: null, city: null }] }),
    (root) => expect(root.textContent).not.toContain("webshare · "),
  )
})

test("with no vendor configured the section still says what it is and how to use it", () =>
  withSection(
    overview({
      configured: false,
      proxies: [],
      vendors: [{ vendor: "webshare", state: "off", complete: false, error: null }],
    }),
    (root) => {
      expect(root.textContent).toContain("webshare: not configured on this router")
      expect(root.textContent).toContain("No account uses a proxy")
      expect(root.querySelectorAll("table")).toHaveLength(1)
    },
  ))

test("a failed read is an error with a retry, not an empty section", async () => {
  globalThis.fetch = (async () =>
    Response.json(
      { error: { message: "router said no" } },
      { status: 403 },
    )) as unknown as typeof fetch
  const root = document.createElement("div")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <EgressProxiesSection />
      </QueryClientProvider>
    ),
    root,
  )
  try {
    await settle()
    expect(root.querySelector('[role="alert"]')?.textContent).toContain("router said no")
    expect(root.textContent).toContain("Try again")
  } finally {
    dispose()
    client.clear()
  }
})

test("a proxy its vendor disowns is kept while it answers, and the row says both", () =>
  withSection(
    overview({ assigned: [assignment({ replace: "on-failure", listed: false, valid: false })] }),
    (root) => {
      expect(root.textContent).toContain("It still answers, so it is kept.")
      expect(root.textContent).toContain("no longer lists it")
    },
  ))
