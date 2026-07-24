import { createEffect, createSignal } from "solid-js"
import { nextTheme, type ThemePreference, themeLabel } from "../lib/theme"
import { applyTheme, loadTheme, storeTheme } from "../lib/theme-dom"
import styles from "./ThemeToggle.module.scss"

/**
 * Cycles system → dark → light. The preference is the only state; the document
 * attribute is derived from it.
 */
export function ThemeToggle() {
  const [preference, setPreference] = createSignal<ThemePreference>(loadTheme())

  // The sanctioned use of `createEffect`: syncing reactive state to something
  // outside the reactive graph — here, the attribute on <html> that the token
  // cascade in `tokens.scss` reads. It is not for deriving state; anything
  // derived is a `createMemo`.
  createEffect(() => {
    applyTheme(preference(), document.documentElement)
  })

  // Read inside an event handler rather than a tracking scope: the current
  // value is exactly what is wanted here.
  const cycle = () => {
    const next = nextTheme(preference())
    setPreference(next)
    storeTheme(next)
  }

  return (
    <button class={styles.button} type="button" onClick={cycle} aria-live="polite">
      {themeLabel(preference())}
    </button>
  )
}
