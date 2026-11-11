import { expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { createFocusTrap } from "../../src/lib/focus-trap"

/**
 * A confirmed delete removes the row whose button opened the dialog before the dialog closes.
 * Restoring focus to that detached button dropped keyboard focus to `<body>`; the trap now falls
 * back to the page's main landmark.
 */
test("focus goes to <main> when the node that opened the dialog is gone", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const main = document.createElement("main")
  main.tabIndex = -1
  const opener = document.createElement("button")
  main.appendChild(opener)
  host.appendChild(main)
  opener.focus()

  const [open, setOpen] = createSignal(false)
  const dispose = render(() => {
    let panel: HTMLDivElement | undefined
    createFocusTrap({ container: () => panel, active: open, onEscape: () => setOpen(false) })
    return (
      <div ref={panel}>
        <button type="button">inside</button>
      </div>
    )
  }, host)
  try {
    setOpen(true)
    opener.remove()
    setOpen(false)
    expect(document.activeElement === main).toBe(true)
  } finally {
    dispose()
    host.remove()
  }
})

test("focus returns to the opener when it is still on the page", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const opener = document.createElement("button")
  host.appendChild(opener)
  opener.focus()

  const [open, setOpen] = createSignal(false)
  const dispose = render(() => {
    let panel: HTMLDivElement | undefined
    createFocusTrap({ container: () => panel, active: open, onEscape: () => setOpen(false) })
    return (
      <div ref={panel}>
        <button type="button">inside</button>
      </div>
    )
  }, host)
  try {
    setOpen(true)
    setOpen(false)
    expect(document.activeElement === opener).toBe(true)
  } finally {
    dispose()
    host.remove()
  }
})
