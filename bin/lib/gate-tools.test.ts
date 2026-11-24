import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { SQL } from "bun"
import { bareSpecifiers } from "./assert-bundles-self-contained"
import { OWNERSHIP_MARK, quoteIdentifier, shardDatabaseName } from "./ensure-test-database"

const HERE = fileURLToPath(new URL(".", import.meta.url))

function run(script: string, args: readonly string[] = [], stdin?: string) {
  const child = Bun.spawnSync(["bun", join(HERE, script), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
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
      const result = run("assert-bundles-self-contained.ts", [bundle])
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
      expect(run("assert-bundles-self-contained.ts", [bundle]).status).toBe(0)
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
    const result = run("ensure-test-database.ts", ["1"], BASE)
    expect(result.status).toBe(0)
    expect(result.stdout).toBe(BASE)
  })

  test("the URL is read from stdin; one passed as an argument is a usage error", () => {
    // It carries a password, and an argument sits in the process list.
    const result = run("ensure-test-database.ts", [BASE, "1"])
    expect(result.status).toBe(64)
    expect(result.stderr).toContain("stdin")
    expect(run("ensure-test-database.ts", ["1"], "").status).toBe(64)
  })

  test("a missing or non-numeric shard is a usage error", () => {
    expect(run("ensure-test-database.ts", [], BASE).status).toBe(64)
    expect(run("ensure-test-database.ts", ["two"], BASE).status).toBe(64)
  })

  test("any base name is allowed, because the derived one is quoted", () => {
    // `router-dev` ran under the single-process runner; a shard must not be the thing that breaks it.
    expect(shardDatabaseName("router-dev", 2)).toEqual({ ok: true, name: "router-dev_shard2" })
    expect(quoteIdentifier("router-dev_shard2")).toBe('"router-dev_shard2"')
    expect(quoteIdentifier('ro"uter')).toBe('"ro""uter"')
  })

  test("a derived name PostgreSQL would truncate is refused, by its byte length", () => {
    // 63 bytes is the limit, and truncation is silent: two shards could land in one database.
    expect(shardDatabaseName("a".repeat(56), 2)).toEqual({
      ok: true,
      name: `${"a".repeat(56)}_shard2`,
    })
    expect(shardDatabaseName("a".repeat(57), 2).ok).toBe(false)
    // Bytes, not characters: 28 two-byte letters and the suffix are 63 bytes, 29 are 65.
    expect(shardDatabaseName("é".repeat(28), 2).ok).toBe(true)
    expect(shardDatabaseName("é".repeat(29), 2).ok).toBe(false)
    expect(shardDatabaseName("", 2).ok).toBe(false)
  })

  const liveUrl = process.env.DATABASE_URL
  test.skipIf(!liveUrl)(
    "a shard database is created stamped, reused only with the stamp, and never adopted by name",
    async () => {
      const base = liveUrl ?? ""
      // A shard number nothing else uses, so this cannot meet a real run's database.
      const shard = 900_000 + Math.floor(Math.random() * 90_000)
      const named = shardDatabaseName(decodeURIComponent(new URL(base).pathname.slice(1)), shard)
      if (!named.ok) throw new Error(named.reason)
      const quoted = quoteIdentifier(named.name)
      const sql = new SQL(base)
      const mark = async () =>
        (
          await sql`SELECT shobj_description(oid, 'pg_database') AS mark FROM pg_database WHERE datname = ${named.name}`
        )[0]?.mark
      try {
        // Somebody else's database that happens to have the name: the suites would truncate it.
        await sql.unsafe(`CREATE DATABASE ${quoted}`)
        const refused = run("ensure-test-database.ts", [String(shard)], base)
        expect(refused.status).toBe(1)
        expect(refused.stderr).toContain("bin/test did not create it")
        expect(refused.stdout).toBe("")
        expect(await mark()).toBeNull()

        // Absent — a fresh server, as in CI: created, stamped, and its URL printed.
        await sql.unsafe(`DROP DATABASE ${quoted}`)
        const created = run("ensure-test-database.ts", [String(shard)], base)
        expect(created.status).toBe(0)
        expect(new URL(created.stdout).pathname).toBe(`/${encodeURIComponent(named.name)}`)
        expect(await mark()).toBe(OWNERSHIP_MARK)

        // Its own, from an earlier run: reused.
        expect(run("ensure-test-database.ts", [String(shard)], base).status).toBe(0)
      } finally {
        await sql.unsafe(`DROP DATABASE IF EXISTS ${quoted}`)
        await sql.close()
      }
    },
  )
})

describe("auto-install-probe", () => {
  // Loopback only: the probe is its own registry. `tar` is the one external tool it needs.
  test("passes for the bunfig the image ships: fetched by default, refused with it", () =>
    scratch((dir) => {
      const bunfig = join(dir, "bunfig.toml")
      writeFileSync(bunfig, '[install]\nauto = "disable"\n')
      const result = run("auto-install-probe.ts", [bunfig])
      expect(result.stderr).toBe("")
      expect(result.status).toBe(0)
      expect(result.stdout).toContain("0 fetched, import failed")
    }))

  test("fails a bunfig that says the words in a place bun does not read", () =>
    scratch((dir) => {
      // The text check alone would pass this file. The import is what catches it: auto-install is
      // still on, and the probe's registry is reachable, so the package arrives.
      const bunfig = join(dir, "bunfig.toml")
      writeFileSync(bunfig, '[run]\nauto = "disable"\n')
      const result = run("auto-install-probe.ts", [bunfig])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("the import SUCCEEDED")
    }))

  test("fails a bunfig that leaves auto-install on", () =>
    scratch((dir) => {
      const bunfig = join(dir, "bunfig.toml")
      writeFileSync(bunfig, '[install]\nauto = "fallback"\n')
      expect(run("auto-install-probe.ts", [bunfig]).status).toBe(1)
    }))
})

describe("merge-test-timings", () => {
  test("merges the shards' files, sorted, replacing the committed table", () =>
    scratch((dir) => {
      const target = join(dir, "timings.json")
      writeFileSync(target, JSON.stringify({ version: 1, files: { "gone.test.ts": 9 } }))
      writeFileSync(join(dir, "1.json"), JSON.stringify({ version: 1, files: { "b.test.ts": 2 } }))
      writeFileSync(join(dir, "2.json"), JSON.stringify({ version: 1, files: { "a.test.ts": 1 } }))

      expect(
        run("merge-test-timings.ts", [target, join(dir, "1.json"), join(dir, "2.json")]).status,
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

      expect(run("merge-test-timings.ts", [target, join(dir, "1.json")]).status).not.toBe(0)
      expect(readFileSync(target, "utf8")).toBe(before)
    }))
})
