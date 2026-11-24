import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { cx } from "../../src/lib/cx"
import {
  nextTheme,
  parseTheme,
  THEME_PREFERENCES,
  THEME_STORAGE_KEY,
  type ThemePreference,
  themeLabel,
} from "../../src/lib/theme"
import { installTheme } from "../../src/lib/theme-dom"

test("the stored theme is applied at boot, before any route has loaded", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "light")
  const root = document.createElement("html")
  try {
    installTheme(root)
    expect(root.getAttribute("data-theme")).toBe("light")
  } finally {
    localStorage.removeItem(THEME_STORAGE_KEY)
  }
  const boot = readFileSync(join(import.meta.dir, "../../src/main.tsx"), "utf8")
  expect(boot.indexOf("installTheme(")).toBeGreaterThan(-1)
  expect(boot.indexOf("installTheme(")).toBeLessThan(boot.indexOf("render("))
})

describe("parseTheme", () => {
  test("accepts every known preference", () => {
    for (const preference of THEME_PREFERENCES) {
      expect(parseTheme(preference)).toBe(preference)
    }
  })

  test("falls back to system for absent or junk values", () => {
    expect(parseTheme(null)).toBe("system")
    expect(parseTheme("")).toBe("system")
    expect(parseTheme("DARK")).toBe("system")
    expect(parseTheme("solarized")).toBe("system")
  })
})

describe("nextTheme", () => {
  test("cycles system → dark → light → system", () => {
    expect(nextTheme("system")).toBe("dark")
    expect(nextTheme("dark")).toBe("light")
    expect(nextTheme("light")).toBe("system")
  })

  test("returns to the starting point after one full cycle", () => {
    let preference: ThemePreference = "system"
    for (let step = 0; step < THEME_PREFERENCES.length; step += 1) {
      preference = nextTheme(preference)
    }
    expect(preference).toBe("system")
  })

  test("labels every preference", () => {
    for (const preference of THEME_PREFERENCES) {
      expect(themeLabel(preference).length).toBeGreaterThan(0)
    }
  })
})

describe("cx", () => {
  // CSS-module lookups are `string | undefined`; "undefined" must never reach a
  // class attribute.
  test("drops falsy parts instead of stringifying them", () => {
    expect(cx("dot", undefined, false, null, "hollow")).toBe("dot hollow")
    expect(cx(undefined, false)).toBe("")
  })
})
