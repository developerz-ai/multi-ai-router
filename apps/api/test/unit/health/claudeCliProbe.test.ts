import { describe, expect, test } from "bun:test"
import { createLogger } from "../../../src/logging/logger"
import type { CliResolution } from "../../../src/providers"
import { createClaudeCliProbe } from "../../../src/services/health/claudeCliProbe"

/**
 * The readiness view of the ladder: it reports the rung, logs the path, and does neither of those
 * twice for an unchanged outcome — an orchestrator polling `/readyz` must not become a log source.
 */

const RESOLVED: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/app/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude",
  bytes: 275_012_592,
}

const UNRESOLVED: CliResolution = {
  ok: false,
  attempts: [{ source: "path_lookup", path: "/usr/local/bin/claude", rejection: "missing" }],
}

interface Harness {
  readonly check: () => Promise<string>
  readonly lines: string[]
}

function harness(resolutions: CliResolution[]): Harness {
  const lines: string[] = []
  const log = createLogger({ level: "debug", write: (line) => lines.push(line) })
  let call = 0
  const resolve = (): CliResolution =>
    resolutions[Math.min(call++, resolutions.length - 1)] as CliResolution
  return { check: createClaudeCliProbe({ override: null, log, resolve }), lines }
}

function entry(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe("the claude cli probe", () => {
  test("reports the winning rung by name", async () => {
    expect(await harness([RESOLVED]).check()).toBe("platform_package")
  })

  test("reports `missing` when the ladder ran out of rungs", async () => {
    expect(await harness([UNRESOLVED]).check()).toBe("missing")
  })

  test("logs the resolved path once, not once per poll", async () => {
    const { check, lines } = harness([RESOLVED])
    await check()
    await check()
    await check()

    const resolved = lines.filter((line) => entry(line).msg === "claude cli resolved")
    expect(resolved).toHaveLength(1)
    expect(entry(resolved[0] ?? "{}")).toMatchObject({
      level: "info",
      component: "claude-sdk",
      source: "platform_package",
      path: RESOLVED.ok ? RESOLVED.path : "",
    })
  })

  test("logs again when the outcome changes, so a fix is visible without a restart", async () => {
    const { check, lines } = harness([UNRESOLVED, RESOLVED, RESOLVED])
    expect(await check()).toBe("missing")
    expect(await check()).toBe("platform_package")
    await check()

    expect(lines.map((line) => entry(line).msg)).toEqual([
      "claude cli not found — Claude subscription accounts cannot be served",
      "claude cli resolved",
    ])
  })

  test("warns rather than errors on a miss — only subscription accounts need the binary", async () => {
    const { check, lines } = harness([UNRESOLVED])
    await check()

    expect(entry(lines[0] ?? "{}")).toMatchObject({ level: "warn", component: "claude-sdk" })
  })

  test("names every refused candidate in the miss line", async () => {
    const { check, lines } = harness([UNRESOLVED])
    await check()

    expect(entry(lines[0] ?? "{}").attempts).toEqual([
      { source: "path_lookup", path: "/usr/local/bin/claude", rejection: "missing" },
    ])
  })
})
