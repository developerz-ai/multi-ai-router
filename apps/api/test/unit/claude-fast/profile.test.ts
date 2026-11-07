import { describe, expect, test } from "bun:test"
import { CLAUDE_FAST_CLI_VERSION } from "../../../src/providers/claude-fast/integrity"
import {
  FAST_BETAS,
  fastHeaders,
  toolUsageHeader,
} from "../../../src/providers/claude-fast/profile"

function headers(toolNames?: readonly string[]) {
  return fastHeaders({
    accessToken: "private-token",
    sessionId: "session",
    contextTag: false,
    ...(toolNames ? { toolNames } : {}),
  })
}

describe("Claude fast profile (2.1.319)", () => {
  test("carries the tool-provenance beta and the native runtime version", () => {
    expect(FAST_BETAS).toContain("tool-provenance-2026-10-26")
    const out = headers()
    expect(out["User-Agent"]).toBe(`claude-cli/${CLAUDE_FAST_CLI_VERSION} (external, cli)`)
    expect(out["User-Agent"]).toContain("2.1.319")
    expect(out["X-Stainless-Runtime-Version"]).toBe("v26.12.1")
    expect(out["X-Stainless-Package-Version"]).toBe("0.128.0")
  })

  test("sends the tool-usage header on every request, empty on a first turn", () => {
    expect(headers()["X-Claude-Code-Sandy-Plover"]).toBe("[]")
    expect(headers(["Bash"])["X-Claude-Code-Sandy-Plover"]).toBe('[{"name":"Bash"}]')
  })

  test("keeps the observed header order: provenance after request class, before request id", () => {
    const keys = Object.keys(headers())
    const at = (name: string) => keys.indexOf(name)
    expect(at("X-Claude-Code-Sandy-Plover")).toBeGreaterThan(at("x-claude-code-request-class"))
    expect(at("X-Claude-Code-Sandy-Plover")).toBeLessThan(at("x-client-request-id"))
  })

  test("lists used tools as JSON descriptors, client tools before built-ins", () => {
    expect(toolUsageHeader([])).toBe("[]")
    expect(toolUsageHeader(["Agent"])).toBe('[{"name":"Agent"}]')
    expect(toolUsageHeader(["Read", "mcp__trace__echo"])).toBe(
      '[{"name":"mcp__trace__echo"},{"name":"Read"}]',
    )
    expect(toolUsageHeader(["Bash", "Bash"])).toBe('[{"name":"Bash"}]')
  })

  test("marks a truncated list with the native sentinel inside the same cap", () => {
    const names = Array.from({ length: 80 }, (_, i) => `tool_${i}`)
    const parsed = JSON.parse(toolUsageHeader(names)) as { name: string }[]
    expect(parsed).toHaveLength(64)
    expect(parsed[0]?.name).toBe("unreadable-tools-used-before-summary")
    expect(toolUsageHeader(["x".repeat(257)])).toBe("[]")
  })
})
