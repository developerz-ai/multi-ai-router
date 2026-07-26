import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import { Banner } from "../../src/components/Banner"

/**
 * `container` is queried directly (not `document.body`) and removed after —
 * `happy-dom`'s `document` is one global shared by every test file in this
 * process, so scoping queries and cleanup to this mount is what keeps one
 * test's markup from being mistaken for another's.
 */
function withMount(
  props: Parameters<typeof Banner>[0],
  run: (container: HTMLElement) => void,
): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <Banner {...props} />, container)
  try {
    run(container)
  } finally {
    dispose()
    container.remove()
  }
}

describe("Banner", () => {
  test("renders the danger tone the dashboard uses for exhausted accounts — not a buried status", () => {
    withMount(
      {
        tone: "danger",
        title: "1 account(s) exhausted",
        children: "Out of credits, no reset to wait for — needs top-up: prod-claude-1",
      },
      (container) => {
        const section = container.querySelector("section")
        expect(section?.className ?? "").toContain("danger")
        expect(container.textContent).toContain("1 account(s) exhausted")
        expect(container.textContent).toContain("needs top-up: prod-claude-1")
      },
    )
  })

  test("defaults to the info tone when no tone is given", () => {
    withMount({ title: "Fleet health at a glance" }, (container) => {
      const section = container.querySelector("section")
      expect(section?.className ?? "").toContain("info")
      expect(section?.className ?? "").not.toContain("danger")
    })
  })

  test("is a standing statement (role=status), never an interrupting alert", () => {
    withMount({ tone: "danger", title: "1 account(s) exhausted" }, (container) => {
      expect(container.querySelector('[role="status"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).toBeNull()
    })
  })

  test("renders at most one action", () => {
    withMount(
      {
        title: "Re-check needed",
        action: <button type="button">Re-check all</button>,
      },
      (container) => {
        const buttons = container.querySelectorAll("button")
        expect(buttons.length).toBe(1)
        expect(buttons[0]?.textContent).toBe("Re-check all")
      },
    )
  })
})
