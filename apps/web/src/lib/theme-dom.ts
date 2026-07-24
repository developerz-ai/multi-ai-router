import { parseTheme, THEME_STORAGE_KEY, type ThemePreference } from "./theme"

// The DOM half of the theme toggle, kept apart from the pure half so the rules
// stay unit-testable without a browser. `"system"` removes the attribute
// entirely rather than writing a value — the media query in `tokens.scss` is
// the fallback, and leaving a stale attribute behind would pin it.

export function applyTheme(preference: ThemePreference, root: HTMLElement): void {
  if (preference === "system") {
    root.removeAttribute("data-theme")
    return
  }
  root.setAttribute("data-theme", preference)
}

export function loadTheme(): ThemePreference {
  try {
    return parseTheme(localStorage.getItem(THEME_STORAGE_KEY))
  } catch {
    // Private mode, blocked storage — a missing preference is not an error.
    return "system"
  }
}

export function storeTheme(preference: ThemePreference): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, preference)
  } catch {
    // Preference simply does not survive the reload. Nothing to report.
  }
}
