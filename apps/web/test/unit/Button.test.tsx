import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Button } from "../../src/components/Button"

/**
 * A button that disables itself the moment it is pressed drops keyboard focus to `<body>`, and a
 * dialog opened by its answer then has nowhere to give focus back to.
 */
test("a busy button keeps focus and swallows the press", () => {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const [busy, setBusy] = createSignal(false)
  let presses = 0
  const dispose = render(
    () => (
      <Button busy={busy()} onClick={() => setBusy(++presses > 0)}>
        Reveal
      </Button>
    ),
    root,
  )
  try {
    const button = root.querySelector("button")
    button?.focus()
    button?.click()
    button?.click()
    expect(presses).toBe(1)
    expect(button?.disabled).toBe(false)
    expect(button?.getAttribute("aria-disabled")).toBe("true")
    expect(button?.getAttribute("aria-busy")).toBe("true")
    expect(document.activeElement === button).toBe(true)
  } finally {
    dispose()
    root.remove()
  }
})

test("a busy submit button does not submit its form again", () => {
  const root = document.createElement("div")
  document.body.appendChild(root)
  const [busy, setBusy] = createSignal(false)
  let submits = 0
  const dispose = render(
    () => (
      <form
        onSubmit={(event) => {
          event.preventDefault()
          submits += 1
        }}
      >
        <Button busy={busy()} type="submit">
          Save
        </Button>
      </form>
    ),
    root,
  )
  try {
    root.querySelector("button")?.click()
    expect(submits).toBe(1)
    setBusy(true)
    root.querySelector("button")?.click()
    expect(submits).toBe(1)
  } finally {
    dispose()
    root.remove()
  }
})
