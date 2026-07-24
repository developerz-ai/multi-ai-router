import { type Accessor, createSignal, onCleanup } from "solid-js"

/**
 * The sidebar threshold, mirrored from `styles/_breakpoints.scss` ($sidebar:
 * 48rem). CSS decides the *layout* at this width; JS needs the same number
 * because the drawer's focus trap and `inert` handling must be inactive once
 * the nav is a permanent sidebar. Change one, change the other.
 */
export const SIDEBAR_QUERY = "(min-width: 48rem)"

/**
 * A media query as a signal. This is a genuine escape from the reactive graph
 * — `matchMedia` is a browser event source — so the listener is registered
 * once per owner and torn down with it.
 */
export function createMediaQuery(query: string): Accessor<boolean> {
  const list = window.matchMedia(query)
  const [matches, setMatches] = createSignal(list.matches)

  const onChange = (event: MediaQueryListEvent) => setMatches(event.matches)
  list.addEventListener("change", onChange)
  onCleanup(() => list.removeEventListener("change", onChange))

  return matches
}
