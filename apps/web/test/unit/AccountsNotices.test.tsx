import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { AccountsNotices } from "../../src/routes/accounts/AccountsNotices"

const IDLE = { isError: false, error: null, isSuccess: false, data: undefined }
const FAILED = { ...IDLE, isError: true, error: new Error("the router said no") }

function text(overrides: Partial<Parameters<typeof AccountsNotices>[0]>): string {
  const container = document.createElement("div")
  const dispose = render(
    () => (
      <AccountsNotices
        discover={IDLE}
        enableError={null}
        recheck={IDLE}
        recheckAll={IDLE}
        test={IDLE}
        {...overrides}
      />
    ),
    container,
  )
  const rendered = container.textContent ?? ""
  dispose()
  return rendered
}

describe("AccountsNotices", () => {
  // Each of these was a row button whose failure rendered nowhere: the press simply did nothing.
  test("a failed row Re-check says so", () => {
    expect(text({ recheck: FAILED })).toContain("Re-check failed")
  })

  test("a failed Test now says so", () => {
    expect(text({ test: FAILED })).toContain("Test could not run")
  })

  test("a failed Enable says so", () => {
    expect(text({ enableError: new Error("no") })).toContain("Enable failed")
  })

  test("nothing failed, nothing shown", () => {
    expect(text({})).toBe("")
  })
})
