import { describe, expect, test } from "bun:test"
import {
  CreditsExhaustedError,
  defaultWallScope,
  isRetryableWall,
  NoHealthyAccountError,
  QuotaExhaustedError,
  ROUTER_ERROR_CODES,
  ScopeViolationError,
  WALL_SCOPES,
  WALLS,
  wallOf,
} from "../../src/index"

/**
 * The wall is a function of the code, so it can never disagree with the status the same code
 * renders: `429` clock, `402` human, `403` scope, `503` capacity (docs/idea/06, the router error
 * object). A new code does not compile until it has one (`wall.ts`, `WALL_OF`).
 */
describe("wallOf", () => {
  test("every code names a known wall and scope", () => {
    for (const code of ROUTER_ERROR_CODES) {
      expect(WALLS).toContain(wallOf(code))
      expect(WALL_SCOPES).toContain(defaultWallScope(code))
    }
  })

  test("the data plane's statuses map onto their walls", () => {
    expect(wallOf(new QuotaExhaustedError("x").code)).toBe("clock")
    expect(wallOf("key_rate_limited")).toBe("clock")
    expect(wallOf(new CreditsExhaustedError("x").code)).toBe("human")
    expect(wallOf(new ScopeViolationError("x").code)).toBe("scope")
    expect(wallOf(new NoHealthyAccountError("x").code)).toBe("capacity")
    expect(wallOf("key_verification_unavailable")).toBe("capacity")
  })

  test("only a clock or capacity wall is retryable", () => {
    expect(WALLS.filter(isRetryableWall)).toEqual(["clock", "capacity"])
  })
})

describe("RouterError.detail", () => {
  test("is empty unless the throw site states it", () => {
    expect(new NoHealthyAccountError("x").detail).toEqual({})
  })

  test("travels through every init shape", () => {
    const detail = { scope: "account", signal: "http-status:429" } as const
    expect(new QuotaExhaustedError("x", { retryAfterSeconds: 1, detail }).detail).toEqual(detail)
    expect(new CreditsExhaustedError("x", { detail }).detail).toEqual(detail)
  })
})
