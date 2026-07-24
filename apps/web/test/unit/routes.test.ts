import { describe, expect, test } from "bun:test"
import { CONSOLE_ROUTES, LOGIN_PATH, loginPathFor, safeNextPath } from "../../src/lib/routes"

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

// The redirect a lost session performs. Two failure modes are worth a test each:
// a loop back onto the login screen, and an open redirect off this origin.
describe("loginPathFor", () => {
  test("carries the surface the operator was on", () => {
    expect(loginPathFor("/keys")).toBe("/login?next=%2Fkeys")
  })

  test("never points back at itself, and never at the default surface", () => {
    expect(loginPathFor(LOGIN_PATH)).toBe(LOGIN_PATH)
    expect(loginPathFor("/")).toBe(LOGIN_PATH)
  })
})

describe("safeNextPath", () => {
  test("round-trips a console path", () => {
    expect(safeNextPath("/accounts")).toBe("/accounts")
  })

  test("refuses anything that leaves this origin", () => {
    expect(safeNextPath("//evil.example/steal")).toBe("/")
    expect(safeNextPath("https://evil.example")).toBe("/")
    expect(safeNextPath("javascript:alert(1)")).toBe("/")
  })

  test("a missing or repeated parameter falls back to the overview", () => {
    expect(safeNextPath(undefined)).toBe("/")
    expect(safeNextPath(["/keys", "/pools"])).toBe("/")
  })
})
