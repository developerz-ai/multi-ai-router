import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * The tmp/ exclusion used to be a `bin/test` flag, so the documented raw `bun test <pattern>` at
 * the root collected the cloned upstream repos' thousands of tests. Bun reads `bunfig.toml` from
 * the working directory for every `bun test`, so the exclusion and the database-gate preload
 * belong there — held here so neither can drift back into one wrapper.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

interface Bunfig {
  readonly test?: {
    readonly pathIgnorePatterns?: readonly string[]
    readonly preload?: readonly string[]
  }
}

const BUNFIG = Bun.TOML.parse(readFileSync(`${ROOT}bunfig.toml`, "utf8")) as Bunfig

describe("bunfig.toml", () => {
  test("excludes tmp/ for every bun test run, not only bin/test", () => {
    expect(BUNFIG.test?.pathIgnorePatterns).toContain("**/tmp/**")
  })

  test("preloads the database gate before anything else", () => {
    expect(BUNFIG.test?.preload?.[0]).toBe("./apps/api/test/support/database-gate-preload.ts")
  })
})
