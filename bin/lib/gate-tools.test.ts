import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { bareSpecifiers } from "./assert-bundles-self-contained"

const HERE = fileURLToPath(new URL(".", import.meta.url))

function run(script: string, ...args: string[]) {
  const child = Bun.spawnSync(["bun", join(HERE, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    status: child.exitCode,
    stdout: child.stdout.toString(),
    stderr: child.stderr.toString(),
  }
}

async function scratch(use: (dir: string) => void | Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "gate-tools-"))
  try {
    await use(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("assert-bundles-self-contained", () => {
  test("a bundle that still imports a package by name fails, and names it", () =>
    scratch((dir) => {
      const bundle = join(dir, "index.js")
      writeFileSync(
        bundle,
        'import a from "left-pad"; const b = require("ajv/dist/core"); await import("hono")',
      )
      const result = run("assert-bundles-self-contained.ts", bundle)
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("ajv/dist/core, hono, left-pad")
    }))

  test("builtins, bun modules and paths are what a bundle may import", async () => {
    await scratch(async (dir) => {
      const bundle = join(dir, "index.js")
      writeFileSync(
        bundle,
        [
          'import { join } from "node:path"',
          'import fs from "fs"',
          'import { SQL } from "bun"',
          'import { Database } from "bun:sqlite"',
          'import "./chunk.js"',
          // Generated code quoted in a string is not an import of this module.
          'const generated = "require(\\"ajv/dist/runtime/equal\\")"',
        ].join("\n"),
      )
      expect(await bareSpecifiers(bundle)).toEqual([])
      expect(run("assert-bundles-self-contained.ts", bundle).status).toBe(0)
    })
  })

  test("no bundle named is a usage error, not a pass", () => {
    expect(run("assert-bundles-self-contained.ts").status).toBe(64)
  })
})

describe("ensure-test-database", () => {
  const BASE = "postgres://router:router@127.0.0.1:1/router"

  test("the first shard keeps the database the caller named, without connecting", () => {
    // Port 1 refuses connections: an exit 0 proves nothing was dialled.
    const result = run("ensure-test-database.ts", BASE, "1")
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(BASE)
  })

  test("a database name that would need quoting is refused before any DDL", () => {
    const result = run("ensure-test-database.ts", 'postgres://u:p@127.0.0.1:1/ro"uter', "2")
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("refusing database name")
  })

  test("a missing or non-numeric shard is a usage error", () => {
    expect(run("ensure-test-database.ts", BASE).status).toBe(64)
    expect(run("ensure-test-database.ts", BASE, "two").status).toBe(64)
  })
})

describe("merge-test-timings", () => {
  test("merges the shards' files, sorted, replacing the committed table", () =>
    scratch((dir) => {
      const target = join(dir, "timings.json")
      writeFileSync(target, JSON.stringify({ version: 1, files: { "gone.test.ts": 9 } }))
      writeFileSync(join(dir, "1.json"), JSON.stringify({ version: 1, files: { "b.test.ts": 2 } }))
      writeFileSync(join(dir, "2.json"), JSON.stringify({ version: 1, files: { "a.test.ts": 1 } }))

      expect(
        run("merge-test-timings.ts", target, join(dir, "1.json"), join(dir, "2.json")).status,
      ).toBe(0)
      expect(readFileSync(target, "utf8")).toBe(
        `${JSON.stringify({ version: 1, files: { "a.test.ts": 1, "b.test.ts": 2 } }, null, 2)}\n`,
      )
    }))

  test("shards that measured nothing leave the committed table alone", () =>
    scratch((dir) => {
      const target = join(dir, "timings.json")
      const before = JSON.stringify({ version: 1, files: { "kept.test.ts": 5 } })
      writeFileSync(target, before)
      writeFileSync(join(dir, "1.json"), JSON.stringify({ version: 1, files: {} }))

      expect(run("merge-test-timings.ts", target, join(dir, "1.json")).status).not.toBe(0)
      expect(readFileSync(target, "utf8")).toBe(before)
    }))
})
