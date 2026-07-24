import { createEffect, onCleanup } from "solid-js"

// Focus containment for the mobile navigation drawer. Small and specific: this
// is not a dialog library, and it grows an option only when a second overlay
// needs one.

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",")

function focusable(container: HTMLElement): HTMLElement[] {
  // `getClientRects()` rather than `offsetParent`: the drawer is
  // `position: fixed`, and `offsetParent` is unreliable inside a fixed subtree.
  // This asks the only question that matters — is the element laid out?
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (element) => element.getClientRects().length > 0,
  )
}

export interface FocusTrapOptions {
  /** The element to contain focus within. */
  readonly container: () => HTMLElement | undefined
  /** Trap only while this is true — false on desktop, where nav is not modal. */
  readonly active: () => boolean
  readonly onEscape: () => void
  /** Where focus goes on close. Defaults to whatever had it when the trap opened. */
  readonly restoreTo?: () => HTMLElement | undefined
}

/**
 * Traps Tab within `container` while `active()`, closes on `Escape`, and puts
 * focus back where it came from on the way out.
 *
 * Cleanup is the whole point: Solid disposes the previous run before the next,
 * so the listener and the focus restore fire exactly once when `active()` flips
 * to false — and again if the component unmounts while open.
 */
export function createFocusTrap(options: FocusTrapOptions): void {
  createEffect(() => {
    if (!options.active()) return

    const container = options.container()
    if (container === undefined) return

    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    focusable(container)[0]?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault()
        options.onEscape()
        return
      }
      if (event.key !== "Tab") return

      const items = focusable(container)
      const first = items[0]
      const last = items[items.length - 1]
      if (first === undefined || last === undefined) return

      const active = document.activeElement
      const outside = !container.contains(active)

      if (event.shiftKey && (active === first || outside)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || outside)) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener("keydown", onKeyDown)

    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown)
      const restore = options.restoreTo?.() ?? previous
      restore?.focus()
    })
  })
}
