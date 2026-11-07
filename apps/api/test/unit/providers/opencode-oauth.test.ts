import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { account, response } from "./fixtures"

const driver = httpDriver("opencode-oauth")
if (!driver?.oauth?.device) throw new Error("OpenCode device flow missing")
const flow = driver.oauth
const device = driver.oauth.device
const tokens = {
  access_token: "test-access",
  refresh_token: "test-refresh",
  expires_in: 3600,
  org_id: "org-test",
}

describe("OpenCode Console OAuth", () => {
  test("is independent of Go API keys, with the captured chat endpoint and workspace header", () => {
    const row = account({ provider: "opencode-oauth" })
    expect(driver.authKind).toBe("oauth")
    expect(driver.resolveBaseUrl(row).href).toBe("https://opencode.ai/inference/openai/v1")
    expect(driver.resolveChatCeiling(row)).toBe("max_completion_tokens")
    expect(driver.sessionHeader?.(row)).toBe("x-opencode-session")
    const headers = driver.buildHeaders(row, {
      kind: "oauth",
      accessToken: "test-access",
      providerAccountId: "org-test",
    })
    expect(headers.get("authorization")).toBe("Bearer test-access")
    expect(headers.get("x-opencode-org-id")).toBe("org-test")
    expect(headers.get("user-agent")).toBe("developerz.ai")
    expect(() => driver.buildHeaders(row, null)).toThrow()
    expect(() => driver.buildHeaders(row, { kind: "oauth", accessToken: "test-access" })).toThrow()
    expect(httpDriver("opencode-go")?.authKind).toBe("api-key")
  })

  test("device initiation and polling use JSON, the native client id and org scoping", () => {
    const start = device.userCodeRequest()
    expect(start.url).toBe("https://opencode.ai/console/auth/device/code")
    expect(JSON.parse(start.body)).toEqual({ client_id: "opencode-cli", supports_org_scope: true })
    expect(device.verificationUrl).toBe("https://opencode.ai/console/device")
    const poll = device.pollRequest({ deviceAuthId: "test-handle", userCode: "ABCD-EFGH" })
    expect(poll.url).toBe("https://opencode.ai/console/auth/device/token")
    expect(JSON.parse(poll.body)).toEqual({
      client_id: "opencode-cli",
      device_code: "test-handle",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    })
    expect(
      device.readUserCode({
        device_code: "test-handle",
        user_code: "ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      }),
    ).toEqual({
      deviceAuthId: "test-handle",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 600,
      intervalSeconds: 5,
    })
    expect(
      device.readUserCode({
        device_code: "test-handle",
        user_code: "ABCD-EFGH",
        expires_in: 0,
        interval: 0,
      }),
    ).toBeNull()
  })

  test("400 pending and slow_down are temporary; denial and malformed success are final", () => {
    expect(device.readPoll(400, { error: "authorization_pending" })).toEqual({ kind: "pending" })
    expect(device.readPoll(400, { error: "slow_down" })).toMatchObject({
      kind: "slow-down",
      increaseSeconds: 5,
    })
    expect(device.readPoll(429, {}, new Headers({ "retry-after": "17" }))).toMatchObject({
      kind: "retry",
      retryAfterSeconds: 17,
    })
    expect(device.readPoll(503, {})).toMatchObject({ kind: "retry" })
    for (const error of ["access_denied", "expired_token", "invalid_grant"])
      expect(device.readPoll(400, { error })).toEqual({ kind: "refused" })
    expect(device.readPoll(200, {})).toEqual({ kind: "refused" })
    expect(device.readPoll(200, { ...tokens, org_id: null })).toEqual({ kind: "refused" })
    expect(device.readPoll(200, tokens)).toEqual({
      kind: "tokens",
      tokens: {
        accessToken: "test-access",
        refreshToken: "test-refresh",
        expiresInSeconds: 3600,
        providerAccountId: "org-test",
      },
    })
  })

  test("Console listing excludes models which have no chat-completions route", () => {
    expect(
      driver.modelListing?.read({
        data: [
          {
            id: "big-pickle",
            api: { "chat-completions": {} },
            limit: { context: 200000, output: 32000 },
          },
          { id: "claude-opus-5-5", api: { messages: {} } },
          { id: "crouton-alpha-free", api: { responses: {} } },
        ],
      }),
    ).toEqual([{ id: "big-pickle", contextTokens: 200000, maxOutputTokens: 32000 }])
  })

  test("refresh preserves workspace identity when absent and persists the rotated refresh token", () => {
    const refresh = flow.refresh({ refreshToken: "test-refresh" })
    expect(JSON.parse(refresh.body)).toEqual({
      client_id: "opencode-cli",
      grant_type: "refresh_token",
      refresh_token: "test-refresh",
    })
    expect(
      flow.readTokens(
        { ...tokens, refresh_token: "rotated", org_id: null },
        {
          previousProviderAccountId: "held-org",
        },
      ),
    ).toMatchObject({ refreshToken: "rotated", providerAccountId: "held-org" })
    expect(flow.readTokens({ ...tokens, refresh_token: "" })).toBeNull()
  })

  test("a prefill capacity refusal is retryable overload for both OpenCode lanes", () => {
    for (const provider of ["opencode-go", "opencode-oauth"] as const) {
      expect(
        httpDriver(provider)?.classifyFailure(
          response(429, {
            body: {
              type: "error",
              error: {
                type: "rate_limit_error",
                message:
                  "Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)",
              },
            },
          }),
        ),
      ).toMatchObject({ kind: "overloaded", retryable: true })
    }
  })

  test("captured free limit cools to Retry-After; overloaded never consumes the account", () => {
    expect(
      driver.classifyFailure(
        response(429, {
          headers: { "retry-after": "38871" },
          body: { type: "error", error: { type: "FreeUsageLimitError" } },
        }),
      ),
    ).toMatchObject({
      kind: "rate-limited",
      rateLimit: { retryAfterSeconds: 38871 },
    })
    expect(
      driver.classifyFailure(
        response(429, {
          body: {
            error: {
              message:
                "Upstream request failed: [overloaded] the server is overloaded; retry shortly",
            },
          },
        }),
      ),
    ).toMatchObject({ kind: "overloaded" })
  })
})
