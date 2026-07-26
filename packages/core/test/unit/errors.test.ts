import { describe, expect, test } from "bun:test"
import {
  AdminAuthError,
  CredentialDecryptError,
  CreditsExhaustedError,
  CsrfTokenError,
  isRouterError,
  KeyRateLimitedError,
  KeyRevokedError,
  ModelNotFoundError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  RetryableRouterError,
  ROUTER_ERROR_CODES,
  RouterError,
  type RouterErrorCode,
  ScopeViolationError,
  TranslationError,
  UpstreamAuthError,
  UpstreamTimeoutError,
} from "../../src/index"

interface ErrorCase {
  readonly name: string
  readonly ctor: new (message: string) => RouterError
  readonly code: RouterErrorCode
  readonly status: number
}

const cases: readonly ErrorCase[] = [
  {
    name: "NoHealthyAccountError",
    ctor: NoHealthyAccountError,
    code: "no_healthy_account",
    status: 503,
  },
  { name: "QuotaExhaustedError", ctor: QuotaExhaustedError, code: "quota_exhausted", status: 429 },
  {
    name: "CreditsExhaustedError",
    ctor: CreditsExhaustedError,
    code: "credits_exhausted",
    status: 402,
  },
  { name: "ScopeViolationError", ctor: ScopeViolationError, code: "scope_violation", status: 403 },
  { name: "KeyRevokedError", ctor: KeyRevokedError, code: "key_revoked", status: 401 },
  {
    name: "KeyRateLimitedError",
    ctor: KeyRateLimitedError,
    code: "key_rate_limited",
    status: 429,
  },
  { name: "AdminAuthError", ctor: AdminAuthError, code: "admin_auth_failed", status: 401 },
  { name: "CsrfTokenError", ctor: CsrfTokenError, code: "csrf_token_invalid", status: 403 },
  {
    name: "UpstreamAuthError",
    ctor: UpstreamAuthError,
    code: "upstream_auth_failed",
    status: 502,
  },
  {
    name: "UpstreamTimeoutError",
    ctor: UpstreamTimeoutError,
    code: "upstream_timeout",
    status: 504,
  },
  {
    name: "CredentialDecryptError",
    ctor: CredentialDecryptError,
    code: "credential_decrypt_failed",
    status: 500,
  },
  { name: "TranslationError", ctor: TranslationError, code: "translation_failed", status: 400 },
  { name: "ModelNotFoundError", ctor: ModelNotFoundError, code: "model_not_found", status: 404 },
]

describe("error hierarchy", () => {
  for (const { name, ctor, code, status } of cases) {
    test(`${name} carries code "${code}" and status ${status}`, () => {
      const error = new ctor("boom")

      expect(error.code).toBe(code)
      expect(error.status).toBe(status)
      expect(error.name).toBe(name)
      expect(error.message).toBe("boom")
      expect(error).toBeInstanceOf(RouterError)
      expect(error).toBeInstanceOf(Error)
    })
  }

  test("every declared code is claimed by exactly one class", () => {
    const claimed = cases.map((c) => c.code).sort()
    expect(claimed).toEqual([...ROUTER_ERROR_CODES].sort())
    expect(new Set(claimed).size).toBe(cases.length)
  })

  test("no two classes disagree about a code's status", () => {
    const statusByCode = new Map<RouterErrorCode, number>()
    for (const { code, status } of cases) {
      const seen = statusByCode.get(code)
      expect(seen === undefined || seen === status).toBe(true)
      statusByCode.set(code, status)
    }
    expect(statusByCode.size).toBe(ROUTER_ERROR_CODES.length)
  })

  test("every status is a non-generic 4xx or 5xx", () => {
    for (const { ctor } of cases) {
      const { status } = new ctor("boom")
      expect(status).toBeGreaterThanOrEqual(400)
      expect(status).toBeLessThan(600)
    }
  })

  test("the cause is preserved", () => {
    const cause = new Error("upstream said no")
    const error = new NoHealthyAccountError("pool empty", { cause })

    expect(error.cause).toBe(cause)
  })
})

describe("rate limited is not out of credits", () => {
  const rateLimited = new QuotaExhaustedError("five-hour window spent")
  const outOfCredits = new CreditsExhaustedError("prepaid balance drained")

  test("they are distinct classes", () => {
    expect(rateLimited).not.toBeInstanceOf(CreditsExhaustedError)
    expect(outOfCredits).not.toBeInstanceOf(QuotaExhaustedError)
  })

  test("they do not share a status", () => {
    expect(rateLimited.status).toBe(429)
    expect(outOfCredits.status).toBe(402)
    expect(rateLimited.status).not.toBe(outOfCredits.status)
  })

  test("they do not share a code", () => {
    expect(rateLimited.code).not.toBe(outOfCredits.code)
  })

  test("only the clock-recoverable one can carry a reset", () => {
    const resetsAt = new Date("2026-07-24T12:00:00.000Z")
    const withReset = new QuotaExhaustedError("window spent", {
      retryAfterSeconds: 900,
      resetsAt,
    })

    expect(withReset.retryAfterSeconds).toBe(900)
    expect(withReset.resetsAt).toBe(resetsAt)
    expect(rateLimited.retryAfterSeconds).toBeUndefined()
    expect(rateLimited.resetsAt).toBeUndefined()
    expect(Object.hasOwn(outOfCredits, "resetsAt")).toBe(false)
    expect(Object.hasOwn(outOfCredits, "retryAfterSeconds")).toBe(false)
  })
})

describe("a key over its own ceiling is not a pool out of capacity", () => {
  const keyLimited = new KeyRateLimitedError("60 requests per 60s", { retryAfterSeconds: 12 })
  const poolLimited = new QuotaExhaustedError("five-hour window spent", { retryAfterSeconds: 12 })

  test("they share the status and nothing else", () => {
    expect(keyLimited.status).toBe(poolLimited.status)
    expect(keyLimited.code).not.toBe(poolLimited.code)
    expect(keyLimited).not.toBeInstanceOf(QuotaExhaustedError)
  })

  test("both can say when to come back", () => {
    for (const error of [keyLimited, poolLimited]) {
      expect(error).toBeInstanceOf(RetryableRouterError)
      expect(error.retryAfterSeconds).toBe(12)
    }
  })

  test("a failure only a human can fix carries no wait", () => {
    // Which is what stops it from being retried on a timer.
    expect(new CreditsExhaustedError("balance drained")).not.toBeInstanceOf(RetryableRouterError)
  })
})

describe("isRouterError", () => {
  test("accepts every router error", () => {
    for (const { ctor } of cases) {
      expect(isRouterError(new ctor("boom"))).toBe(true)
    }
  })

  test("rejects everything else", () => {
    const lookalike = { code: "quota_exhausted", status: 429, message: "boom" }

    expect(isRouterError(new Error("plain"))).toBe(false)
    expect(isRouterError(new TypeError("plain"))).toBe(false)
    expect(isRouterError(lookalike)).toBe(false)
    expect(isRouterError("quota_exhausted")).toBe(false)
    expect(isRouterError(null)).toBe(false)
    expect(isRouterError(undefined)).toBe(false)
  })
})
