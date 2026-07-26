import { describe, expect, test } from "bun:test"
import { onboardingComplete, routerBaseUrl } from "../../src/lib/onboarding"

describe("onboardingComplete", () => {
  test("false until an account, a pool and a key all exist", () => {
    expect(onboardingComplete({ accounts: 0, pools: 0, keys: 0 })).toBe(false)
    expect(onboardingComplete({ accounts: 1, pools: 0, keys: 0 })).toBe(false)
    expect(onboardingComplete({ accounts: 1, pools: 1, keys: 0 })).toBe(false)
    expect(onboardingComplete({ accounts: 0, pools: 1, keys: 1 })).toBe(false)
  })

  test("true once all three exist, regardless of how many", () => {
    expect(onboardingComplete({ accounts: 1, pools: 1, keys: 1 })).toBe(true)
    expect(onboardingComplete({ accounts: 5, pools: 2, keys: 9 })).toBe(true)
  })
})

describe("routerBaseUrl", () => {
  test("the configured PUBLIC_URL wins when set", () => {
    expect(routerBaseUrl("https://router.example.com", "http://localhost:5173")).toBe(
      "https://router.example.com",
    )
  })

  test("falls back to the browser's own origin otherwise — same origin, no CORS", () => {
    expect(routerBaseUrl(null, "http://localhost:5173")).toBe("http://localhost:5173")
  })
})
