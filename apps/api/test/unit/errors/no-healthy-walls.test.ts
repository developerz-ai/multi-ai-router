import { describe, expect, test } from "bun:test"
import { NoHealthyAccountError } from "@multi-ai-router/core"
import { resolveBaseUrl } from "../../../src/providers/base-url"
import { claudeSdkDriver } from "../../../src/providers/claude-sdk/driver"

/**
 * A `NoHealthyAccountError` is a `503`, but an account the operator left half-configured does not
 * come back on a retry: those throw sites name the `human` wall (`packages/core/src/wall.ts`).
 */
function wallOfThrow(run: () => unknown): string | undefined {
  try {
    run()
  } catch (error) {
    return error instanceof NoHealthyAccountError ? error.wall : undefined
  }
  return undefined
}

describe("misconfigured accounts are a person's wall", () => {
  test("no base URL", () => {
    expect(
      wallOfThrow(() => resolveBaseUrl({ id: "a", provider: "openai-compatible" }, null)),
    ).toBe("human")
  })

  test("an unusable base URL", () => {
    expect(
      wallOfThrow(() =>
        resolveBaseUrl({ id: "a", provider: "openai-compatible", baseUrl: "::nope" }, null),
      ),
    ).toBe("human")
  })

  test("a Claude subscription with no config directory", () => {
    expect(wallOfThrow(() => claudeSdkDriver.resolveConfigDir({ id: "a", configDir: null }))).toBe(
      "human",
    )
  })
})
