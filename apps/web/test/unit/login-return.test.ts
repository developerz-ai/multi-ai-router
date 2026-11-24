import { afterEach, expect, test } from "bun:test"
import { rememberReturn, takeReturn } from "../../src/lib/login-return"

afterEach(() => sessionStorage.clear())

test("the single sign-on hop keeps the destination, once", () => {
  rememberReturn("/usage?window=30d")
  expect(takeReturn()).toBe("/usage?window=30d")
  expect(takeReturn()).toBe("/")
})

test("a failed attempt's retry keeps it, and a stored value cannot leave this origin", () => {
  rememberReturn("/keys")
  rememberReturn("/")
  expect(takeReturn()).toBe("/keys")
  sessionStorage.setItem("mar.loginReturn", "//evil.example")
  expect(takeReturn()).toBe("/")
})
