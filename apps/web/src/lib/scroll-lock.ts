import { createEffect, onCleanup } from "solid-js"

/**
 * Holds the page still while a modal overlay is open, so a swipe over the
 * scrim does not scroll the console behind the drawer.
 *
 * The lock is strictly scoped to `active()`: the previous inline value is
 * captured and put back on cleanup, which Solid runs when `active()` goes false
 * *and* if the owner is disposed mid-open. A page left permanently unscrollable
 * is the failure mode this shape exists to rule out — the drawer itself keeps
 * its own scrolling and uses `overscroll-behavior: contain` so it never chains
 * back to the document.
 */
export function createScrollLock(active: () => boolean): void {
  createEffect(() => {
    if (!active()) return

    const root = document.documentElement
    const previous = root.style.overflow
    root.style.overflow = "hidden"

    onCleanup(() => {
      root.style.overflow = previous
    })
  })
}
