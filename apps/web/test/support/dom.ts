/**
 * Driving a mounted component the way an operator does.
 *
 * Every helper here dispatches happy-dom's own `Event` rather than the global
 * one, because the global is Bun's and happy-dom will not bubble a foreign
 * instance — a Solid `onInput` is delegated to `document`, so it would silently
 * never run (see `DomEvent` in `solid-plugin.ts`). `.click()` needs none of
 * this: happy-dom builds that event itself.
 */

import { DomEvent } from "./solid-plugin"

/** Replaces a control's value and tells the component about it. */
export function typeInto(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  element.value = value
  fire(element, "input")
}

/** Picks an option and tells the component about it. `change`, as a real select does. */
export function selectOption(element: HTMLSelectElement, value: string): void {
  element.value = value
  fire(element, "change")
}

export function fire(element: Element, type: string): void {
  element.dispatchEvent(new DomEvent(type, { bubbles: true, cancelable: true }))
}
