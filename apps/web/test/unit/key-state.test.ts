import { expect, test } from "bun:test"
import { keyState } from "../../src/lib/key-state"

const NOW = Date.parse("2026-11-23T00:00:00Z")

test("a key past its expiry is expired, not active; revoked wins over both", () => {
  const at = (expiresAt: string | null, revoked = false) => keyState({ expiresAt, revoked }, NOW)
  expect(at(null)).toBe("active")
  expect(at("2026-11-24T00:00:00Z")).toBe("active")
  expect(at("2026-11-23T00:00:00Z")).toBe("expired")
  expect(at("2026-11-22T00:00:00Z")).toBe("expired")
  expect(at("2026-11-22T00:00:00Z", true)).toBe("revoked")
})
