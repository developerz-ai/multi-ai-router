import { describe, expect, test } from "bun:test"
import { httpDriver, type UpstreamFailureKind } from "../../../src/providers"
import { inspectCodexStreamFrame } from "../../../src/providers/drivers/openai-oauth-stream-errors"
import { response } from "./fixtures"

/** The refusals the Codex CLI ends or waits out (codex-rs main, 2026-11-23), in a stream and over HTTP. */

const codex = httpDriver("openai-oauth")
const OVERLOADED = "Our servers are currently overloaded. Please try again later."

const failed = (error: unknown) => ({ type: "response.failed", response: { error } })

describe("in a 200 stream", () => {
  test.each([
    ["the prod sentence with an unlisted code", { code: "unlisted", message: OVERLOADED }],
    ["the prod sentence alone", { message: OVERLOADED }],
    ["server_is_overloaded", { code: "server_is_overloaded" }],
  ])("%s is the shared backend, not the account", (_label, error) => {
    for (const frame of [failed(error), { type: "error", error }]) {
      const verdict = inspectCodexStreamFrame(frame, undefined)
      expect(verdict?.kind).toBe("overloaded")
      expect(verdict?.signal).toBe("codex:stream-error:server_is_overloaded")
    }
  })

  test.each<readonly [string, UpstreamFailureKind]>([
    ["policy_capacity_unavailable", "overloaded"],
    ["cyber_policy", "invalid-request"],
    ["bio_policy", "invalid-request"],
    ["content_policy_violation", "invalid-request"],
    ["misalignment_policy_violation", "invalid-request"],
    ["inference_hook_denied", "invalid-request"],
    ["model_not_found", "model-unsupported"],
    ["usage_not_included", "credits-exhausted"],
    ["api_key_spend_limit_exceeded", "credits-exhausted"],
  ])("%s is %s", (code, kind) => {
    const verdict = inspectCodexStreamFrame(failed({ code, message: "x" }), undefined)
    expect(verdict?.kind).toBe(kind)
    expect(verdict?.signal).toBe(`codex:stream-error:${code}`)
  })

  test("a plan refusal outside response.error.code does not park the account", () => {
    const verdict = inspectCodexStreamFrame({ type: "error", code: "usage_not_included" }, "error")
    expect(verdict?.kind).toBe("server-error")
  })
})

describe("over HTTP", () => {
  test.each([
    [503, { code: "server_is_overloaded", message: "x" }, "overloaded"],
    [503, { message: OVERLOADED }, "overloaded"],
    [503, { message: "x" }, "server-error"],
    [429, { type: "usage_not_included", message: "x" }, "credits-exhausted"],
    [429, { code: "api_key_spend_limit_exceeded" }, "credits-exhausted"],
  ] as const)("%d %j is %s", (status, error, kind) => {
    expect(codex?.classifyFailure(response(status, { body: { error } }))?.kind).toBe(kind)
  })

  test("a null beside the code in a `detail` envelope costs the null alone", () => {
    const body = { detail: { code: "usage_limit_reached", message: null } }
    expect(codex?.classifyFailure(response(429, { body }))?.signal).toBe(
      "openai-oauth:usage_limit_reached",
    )
  })

  test("a 429 stating only `resets_at` carries that reset", () => {
    const at = 1_795_600_000
    for (const error of [
      { type: "usage_limit_reached", resets_at: at },
      { type: "usage_limit_reached", resets_at: at, resets_in_seconds: null },
    ]) {
      const signal = codex?.classifyFailure(response(429, { body: { error } }))?.rateLimit
      expect(signal?.resetsAt).toEqual(new Date(at * 1000))
      expect(signal?.resetSource).toBe("provider-reported")
    }
  })

  test("an unusable `resets_at`, or one off a 429, states nothing", () => {
    const read = (status: number, resetsAt: unknown) =>
      codex?.parseRateLimit(response(status, { body: { error: { resets_at: resetsAt } } }))
    for (const value of [0, -1, 1.5, "soon", 9e16])
      expect(read(429, value)?.resetsAt).toBeUndefined()
    expect(read(400, 1_795_600_000)).toBeNull()
  })
})
