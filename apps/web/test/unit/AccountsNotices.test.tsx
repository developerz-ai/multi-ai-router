import { describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { DiscoverModelsResult } from "../../src/lib/api/accounts"
import { createRowRuns } from "../../src/lib/row-runs"
import { AccountsNotices } from "../../src/routes/accounts/AccountsNotices"

const IDLE = { isError: false, error: null }
const no = () => Promise.reject(new Error("the router said no"))

async function failing<T>(...ids: readonly string[]) {
  const runs = createRowRuns<T>()
  for (const id of ids) await runs.run(id, no)
  return runs
}

function mount(overrides: Partial<Parameters<typeof AccountsNotices>[0]>) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <QueryClientProvider client={new QueryClient()}>
        <AccountsNotices
          discover={createRowRuns<DiscoverModelsResult>()}
          enableError={null}
          labelFor={(id) => `label of ${id}`}
          recheck={createRowRuns()}
          recheckAll={IDLE}
          test={createRowRuns()}
          {...overrides}
        />
      </QueryClientProvider>
    ),
    container,
  )
  return {
    container,
    text: () => container.textContent ?? "",
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

const discovered = (accountId: string, notInCatalogue: readonly string[]) =>
  ({ accountId, saved: true, message: "kept", notInCatalogue }) as unknown as DiscoverModelsResult

describe("AccountsNotices", () => {
  // Each of these was a row button whose failure rendered nowhere: the press simply did nothing.
  test("every account whose Re-check failed is named, and one dismissal clears one", async () => {
    const view = mount({ recheck: await failing("a", "b") })
    expect(view.text()).toContain("Re-check failed: label of a")
    expect(view.text()).toContain("Re-check failed: label of b")
    view.container.querySelector("button")?.click()
    expect(view.text()).not.toContain("label of a")
    expect(view.text()).toContain("label of b")
    view.dispose()
  })

  test("a failed Test now and a failed discovery say so", async () => {
    const view = mount({
      test: await failing("a"),
      discover: await failing<DiscoverModelsResult>("b"),
    })
    expect(view.text()).toContain("Test could not run: label of a")
    expect(view.text()).toContain("Model discovery failed: label of b")
    view.dispose()
  })

  test("two accounts with kept models each keep their notice", async () => {
    const discover = createRowRuns<DiscoverModelsResult>()
    await discover.run("a", () => Promise.resolve(discovered("a", ["old-a"])))
    await discover.run("b", () => Promise.resolve(discovered("b", ["old-b"])))
    const view = mount({ discover })
    expect(view.text()).toContain("old-a")
    expect(view.text()).toContain("old-b")
    view.dispose()
  })

  test("a failed Enable says so", () => {
    const view = mount({ enableError: new Error("no") })
    expect(view.text()).toContain("Enable failed")
    view.dispose()
  })

  test("nothing failed, nothing shown", () => {
    const view = mount({})
    expect(view.text()).toBe("")
    view.dispose()
  })
})
