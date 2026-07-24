import { describe, expect, test } from "bun:test"
import { CONSOLE_ROUTES, LOGIN_PATH } from "../../src/lib/routes"

// The route table drives both the router and the navigation, so a mistake here
// is a mistake in two places at once. These are pure structural checks — the
// lazy import thunks are never called.

describe("CONSOLE_ROUTES", () => {
  test("covers the documented console surfaces", () => {
    expect(CONSOLE_ROUTES.map((route) => route.path)).toEqual([
      "/",
      "/accounts",
      "/pools",
      "/keys",
      "/usage",
      "/settings",
    ])
  })

  test("has no duplicate paths", () => {
    const paths = CONSOLE_ROUTES.map((route) => route.path)
    expect(new Set(paths).size).toBe(paths.length)
  })

  test("every route is navigable: absolute path, label, icon", () => {
    for (const route of CONSOLE_ROUTES) {
      expect(route.path.startsWith("/")).toBe(true)
      expect(route.label.length).toBeGreaterThan(0)
      expect(route.icon.length).toBeGreaterThan(0)
    }
  })

  test("each route has its own icon", () => {
    const icons = CONSOLE_ROUTES.map((route) => route.icon)
    expect(new Set(icons).size).toBe(icons.length)
  })

  // Without `end`, the root route prefix-matches every path and the sidebar
  // marks Overview as current on every screen. It is the only route that needs
  // it, and it is the one most easily forgotten.
  test("only the root route opts out of prefix matching", () => {
    const exact = CONSOLE_ROUTES.filter((route) => route.end === true).map((route) => route.path)
    expect(exact).toEqual(["/"])
  })

  test("login lives outside the console shell", () => {
    expect(CONSOLE_ROUTES.map((route) => route.path)).not.toContain(LOGIN_PATH)
  })
})
