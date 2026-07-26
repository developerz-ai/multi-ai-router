import { describe, expect, test } from "bun:test"
import {
  CredentialDecryptError,
  CreditsExhaustedError,
  KeyRevokedError,
  NoHealthyAccountError,
  QuotaExhaustedError,
  type RouterError,
  ScopeViolationError,
  TranslationError,
  UpstreamTimeoutError,
} from "@multi-ai-router/core"
import { dialectForPath, notFoundResponse, toErrorResponse } from "../../src/errors/render"

/** Every class in the hierarchy, with the status docs/idea promises for it. */
const cases: ReadonlyArray<readonly [RouterError, number, string]> = [
  [new NoHealthyAccountError("nothing serviceable"), 503, "no_healthy_account"],
  [new QuotaExhaustedError("window spent"), 429, "quota_exhausted"],
  [new CreditsExhaustedError("out of credits"), 402, "credits_exhausted"],
  [new ScopeViolationError("out of scope"), 403, "scope_violation"],
  [new KeyRevokedError("revoked"), 401, "key_revoked"],
  [new UpstreamTimeoutError("too slow"), 504, "upstream_timeout"],
  [new CredentialDecryptError("cannot decrypt"), 500, "credential_decrypt_failed"],
  [new TranslationError("no counterpart for logprobs"), 400, "translation_failed"],
]

describe("toErrorResponse", () => {
  for (const [error, status, code] of cases) {
    test(`${error.name} renders ${status} / ${code}`, () => {
      const response = toErrorResponse(error, "openai-chat")

      expect(response.status).toBe(status)
      expect(response.body).toMatchObject({ error: { code } })
    })
  }

  test("rate limited and out of credits never collapse onto one status", () => {
    const rateLimited = toErrorResponse(new QuotaExhaustedError("spent"), null)
    const outOfCredits = toErrorResponse(new CreditsExhaustedError("dead"), null)

    expect(rateLimited.status).toBe(429)
    expect(outOfCredits.status).toBe(402)
    expect(outOfCredits.retryAfterSeconds).toBeNull()
  })

  test("carries Retry-After from a quota error that reported one", () => {
    const response = toErrorResponse(
      new QuotaExhaustedError("spent", { retryAfterSeconds: 42 }),
      null,
    )

    expect(response.retryAfterSeconds).toBe(42)
  })

  test("renders a router error in the Anthropic shape for Anthropic ingress", () => {
    const response = toErrorResponse(new KeyRevokedError("key revoked"), "anthropic")

    expect(response.body).toEqual({
      type: "error",
      error: { type: "authentication_error", message: "key revoked" },
    })
  })

  test("renders a router error in the OpenAI shape for OpenAI ingress", () => {
    const response = toErrorResponse(new ScopeViolationError("out of scope"), "openai-responses")

    expect(response.body).toEqual({
      error: {
        message: "out of scope",
        type: "permission_error",
        param: null,
        code: "scope_violation",
      },
    })
  })

  test("an unknown error is a 500 that leaks nothing", () => {
    const response = toErrorResponse(new Error("connection to 10.0.0.4 refused: pw=hunter2"), null)

    expect(response.status).toBe(500)
    expect(JSON.stringify(response.body)).not.toContain("hunter2")
    expect(response.body).toEqual({
      error: { message: "Internal server error", type: "server_error", param: null, code: null },
    })
  })

  test("a non-Error throw is still a 500", () => {
    expect(toErrorResponse("boom", null).status).toBe(500)
  })
})

describe("dialectForPath", () => {
  test("maps each ingress path to its dialect", () => {
    expect(dialectForPath("/v1/messages")).toBe("anthropic")
    expect(dialectForPath("/v1/chat/completions")).toBe("openai-chat")
    expect(dialectForPath("/v1/responses")).toBe("openai-responses")
  })

  test("the token count is an Anthropic path, so its failures wear the Anthropic shape", () => {
    expect(dialectForPath("/v1/messages/count_tokens")).toBe("anthropic")
  })

  test("everything else has no dialect", () => {
    expect(dialectForPath("/api/admin/keys")).toBeNull()
    expect(dialectForPath("/healthz")).toBeNull()
  })
})

describe("notFoundResponse", () => {
  test("uses the ingress dialect's shape", () => {
    expect(notFoundResponse("anthropic").body).toEqual({
      type: "error",
      error: { type: "not_found_error", message: "Not found" },
    })
    expect(notFoundResponse(null).status).toBe(404)
  })
})
