import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

/**
 * Security regression gate, beside `claude-sdk-security.test.ts` (CLAUDE.md non-negotiable 2;
 * 101 finding 05.9). That file asserts the options of the launches it builds; this one asserts
 * there are no others. A new helper that calls `query({ prompt, options: { model } })` without
 * `isolatedOptions` would reach the SDK's built-in tools on this host and load the host's
 * `CLAUDE.md` — and every existing gate would stay green. Not here: every value imported from the
 * Agent SDK is enumerated by name and file, and each `query()` site must build its options from
 * the isolation helpers. Extending the list is a security review, not a test fix.
 *
 * Never skip, quarantine or relax this test.
 */

const SRC = join(import.meta.dir, "../../src")
const SDK = "@anthropic-ai/claude-agent-sdk"

/** Every value (not type) import from the SDK in `apps/api/src`, as `file: name`. */
const PERMITTED_VALUE_IMPORTS = [
  "providers/claude-sdk/idle-query.ts: query",
  "providers/claude-sdk/invoker.ts: query",
  "providers/claude-sdk/test-probe.ts: query",
  // The client-tool MCP declarations whose handlers refuse (`tools/passthrough.ts`).
  "providers/claude-sdk/tools/passthrough.ts: createSdkMcpServer",
  "providers/claude-sdk/tools/passthrough.ts: tool",
].sort()

/** The helpers that set `settingSources: []`, the empty tool set and the deny-all gate. */
const ISOLATION = /\b(isolatedOptions|createQueryLaunch)\(/

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry) ? [path] : []
  })
}

const files = sourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}))

/** Named value bindings of every static `import { … } from SDK`; a type-only import binds none. */
function valueImports(text: string): string[] {
  const names: string[] = []
  // The clause may span lines but never another `import` or `from`: one statement per match.
  const pattern =
    /import\s+(type\s+)?((?:(?!\bimport\b|\bfrom\b)[\s\S])*?)\s*from\s*["']@anthropic-ai\/claude-agent-sdk["']/g
  for (const match of text.matchAll(pattern)) {
    if (match[1]) continue
    const clause = match[2] ?? ""
    const braces = /\{([^}]*)\}/s.exec(clause)
    const outside = clause
      .replace(/\{[^}]*\}/s, "")
      .replace(/,/g, "")
      .trim()
    // A default or namespace import binds everything at once.
    if (outside !== "") names.push(outside)
    for (const spec of (braces?.[1] ?? "").split(",")) {
      const name = spec.trim()
      if (name === "" || name.startsWith("type ")) continue
      names.push(name.split(/\s+as\s+/)[0] ?? name)
    }
  }
  return names
}

describe("every Agent SDK entry point in apps/api/src is enumerated", () => {
  test("value imports from the SDK are exactly the permitted list", () => {
    const found = files
      .flatMap(({ path, text }) => valueImports(text).map((name) => `${path}: ${name}`))
      .sort()
    expect(found).toEqual(PERMITTED_VALUE_IMPORTS)
  })

  test("nothing loads the SDK dynamically or through require", () => {
    const escaped = SDK.replace(/[/.-]/g, "\\$&")
    const dynamic = new RegExp(`(import|require)\\s*\\(\\s*["']${escaped}["']`)
    expect(files.filter(({ text }) => dynamic.test(text)).map(({ path }) => path)).toEqual([])
  })

  test("every query() importer builds its options from the isolation helpers", () => {
    const sites = files.filter(({ text }) => valueImports(text).includes("query"))
    expect(sites).toHaveLength(3)
    for (const { path, text } of sites)
      expect({ path, isolated: ISOLATION.test(text) }).toEqual({ path, isolated: true })
  })

  test("no source passes bypassPermissions, skips permissions, or sets a non-empty settingSources", () => {
    const forbidden = [
      /permissionMode\s*:\s*["'`]bypassPermissions/,
      /allowDangerouslySkipPermissions\s*:\s*true/,
      /settingSources\s*:(?!\s*\[\s*\])/,
    ]
    const offenders = files.flatMap(({ path, text }) =>
      forbidden.filter((pattern) => pattern.test(text)).map((pattern) => `${path} ${pattern}`),
    )
    expect(offenders).toEqual([])
  })
})
