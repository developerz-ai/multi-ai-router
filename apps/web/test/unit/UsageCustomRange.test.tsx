import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { UsageRange } from "../../src/lib/api/usage"
import { UsageCustomRange } from "../../src/routes/usage/UsageCustomRange"

/**
 * The custom-range form's inputs follow the range in the URL (#228). What they must not do is
 * keep the last custom dates once the page has moved to a named window: a form holding dates the
 * page is no longer showing offers to re-apply a range that was already left, and reads as if
 * those dates were still current (#258).
 *
 * `container` is queried directly and removed after, per the Banner suite's note: happy-dom's
 * `document` is one global shared by every test file in the process.
 */

const CUSTOM: UsageRange = {
  from: "2026-10-01T00:00:00.000Z",
  to: "2026-10-08T00:00:00.000Z",
}

function withMount(
  range: UsageRange,
  run: (
    setRange: (next: UsageRange) => void,
    inputs: () => HTMLInputElement[],
    container: HTMLElement,
  ) => void,
): void {
  const [rangeSignal, setRange] = createSignal<UsageRange>(range)
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => <UsageCustomRange range={rangeSignal()} onApply={() => {}} />,
    container,
  )
  const inputs = () =>
    Array.from(container.querySelectorAll<HTMLInputElement>('input[type="datetime-local"]'))
  try {
    run(setRange, inputs, container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("UsageCustomRange", () => {
  test("switching to a named window clears the custom dates from the inputs", () => {
    withMount(CUSTOM, (setRange, inputs, container) => {
      // A deep-linked custom range shows the dates it is showing.
      expect(inputs()).toHaveLength(2)
      expect(inputs().every((input) => input.value.length > 0)).toBe(true)
      expect(container.textContent).toContain("Showing a custom range")

      setRange("7d")

      // The named window is what the page shows now: the inputs hold nothing, so Apply cannot
      // re-send the range the page just left and no stale date waits to be misread as current.
      expect(inputs().map((input) => input.value)).toEqual(["", ""])
      expect(container.textContent).not.toContain("Showing a custom range")
    })
  })

  test("switching back to a custom range repopulates the inputs from it", () => {
    withMount("7d", (setRange, inputs, container) => {
      expect(inputs().map((input) => input.value)).toEqual(["", ""])

      setRange(CUSTOM)

      // The clear is a resync, not a disable: the inputs follow the URL in both directions.
      expect(inputs().every((input) => input.value.length > 0)).toBe(true)
      expect(container.textContent).toContain("Showing a custom range")
    })
  })
})
