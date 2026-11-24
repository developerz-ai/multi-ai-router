import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Glob } from "bun"

/**
 * CLAUDE.md: "Files ≤300 LOC. Split by responsibility, not by size." Until this test the rule was
 * convention only, and 23 source files had drifted past it. Production source only — tests,
 * migrations and generated output are out of scope, as the rule has always been read.
 *
 * The allowlist is a ratchet, not an exemption: each entry is frozen at its current length, may
 * shrink but never grow, and must be removed once the file is back under the limit. Every entry
 * says why it has not been split yet and who owns the split.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const LIMIT = 300
const SOURCE = new Glob("{apps,packages}/*/src/**/*.{ts,tsx}")

/** path → ceiling (its length when frozen, 2026-11-11). */
const OVER_LIMIT: Readonly<Record<string, number>> = {
  // Usage slice (A07): one salvage state machine per dialect; split per dialect is the follow-up.
  "apps/api/src/services/usage/response-salvage.ts": 400,
  // Claude SDK slice (A05): wire re-synthesis per dialect; split with the render/ follow-up.
  "apps/api/src/providers/claude-sdk/render/envelope.ts": 316,
  // Claude SDK slice (A05): the early-stop state machine for forwarded tool calls.
  "apps/api/src/providers/claude-sdk/tools/early-stop.ts": 311,
}

function lineCount(text: string): number {
  // `wc -l` semantics: newline characters, so a trailing newline does not add a line.
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0)
}

const LENGTHS = new Map(
  [...SOURCE.scanSync({ cwd: ROOT })]
    .filter((path) => !/(^|\/)(node_modules|dist)\//.test(path))
    .map((path) => [path, lineCount(readFileSync(`${ROOT}${path}`, "utf8"))] as const),
)

describe("source file size", () => {
  test("finds the source it is meant to hold", () => {
    expect(LENGTHS.size).toBeGreaterThan(100)
  })

  test(`no file outside the allowlist is over ${LIMIT} lines`, () => {
    const over = [...LENGTHS]
      .filter(([path, lines]) => lines > LIMIT && OVER_LIMIT[path] === undefined)
      .map(([path, lines]) => `${path}: ${lines}`)
    expect(over).toEqual([])
  })

  test("no allowlisted file grows past its frozen length", () => {
    const grown = Object.entries(OVER_LIMIT)
      .filter(([path, ceiling]) => (LENGTHS.get(path) ?? 0) > ceiling)
      .map(([path, ceiling]) => `${path}: ${LENGTHS.get(path)} > ${ceiling}`)
    expect(grown).toEqual([])
  })

  test("the allowlist names only files still over the limit", () => {
    // A split file (or a deleted one) leaves its entry behind; drop it so it cannot grow back.
    const stale = Object.keys(OVER_LIMIT).filter((path) => (LENGTHS.get(path) ?? 0) <= LIMIT)
    expect(stale).toEqual([])
  })
})
