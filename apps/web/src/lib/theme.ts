// Theme preference, pure half. `"system"` is a real third state, not an
// absence: dark-first means the default follows `prefers-color-scheme`, and an
// operator who explicitly picked a scheme keeps it in either direction.

export const THEME_PREFERENCES = ["system", "dark", "light"] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]

export const THEME_STORAGE_KEY = "mar.theme"

/** Anything unrecognised — absent, stale, hand-edited — falls back to system. */
export function parseTheme(raw: string | null): ThemePreference {
  return THEME_PREFERENCES.find((value) => value === raw) ?? "system"
}

/** Cycle order for the single-button toggle in the app header. */
export function nextTheme(current: ThemePreference): ThemePreference {
  switch (current) {
    case "system":
      return "dark"
    case "dark":
      return "light"
    case "light":
      return "system"
  }
}

export function themeLabel(preference: ThemePreference): string {
  switch (preference) {
    case "system":
      return "System theme"
    case "dark":
      return "Dark theme"
    case "light":
      return "Light theme"
  }
}
