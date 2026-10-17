import { afterAll, describe, expect, test } from "bun:test"
import { join, resolve } from "node:path"
import { createDatabase } from "@multi-ai-router/db"
import {
  DEFAULTS,
  dropsOnExit,
  existingDbRefusal,
  fixtureMode,
  parseArgs,
  USAGE,
} from "../../bench/usage-summary-lifecycle"

/**
 * Holds `bin/bench-usage` to the database lifecycle #283 asks for: a run destroys only
 * a database it created itself, or one `--drop-existing` explicitly authorized.
 *
 * The prod fingerprint was the opposite — `--db <name>` truncated the usage tables on the
 * seed step and the `finally` block ran `drop database ... with (force)` on whatever name
 * it was handed, so pointing a run at a real database destroyed it without confirmation.
 *
 * The two gates are pure functions, so the truth table below needs no database. The live
 * legs replay the fingerprint with real subprocesses against throwaway databases this
 * file creates beside `DATABASE_URL` and drops afterwards — the only databases these
 * tests ever name. The flagged-drop leg rides `--reuse-db` past the fixture seed (which
 * is minutes of rows at issue-#250 scale): the drop under test happens in the `finally`
 * block either way, and a fresh run reaches that same block through the same
 * `dropsOnExit` gate the truth table pins.
 */

describe("bin/bench-usage fixture gate", () => {
  test("a database the run created is seeded, and only that by default", () => {
    expect(fixtureMode({ fresh: true, reuseDb: false, dropExisting: false })).toBe("seed")
    expect(fixtureMode({ fresh: true, reuseDb: true, dropExisting: false })).toBe("seed")
  })

  test("a pre-existing database with no flag is refused — never truncated, never seeded", () => {
    expect(fixtureMode({ fresh: false, reuseDb: false, dropExisting: false })).toBe("refuse")
  })

  test("--reuse-db keeps its meaning: the existing seed is benchmarked as-is", () => {
    expect(fixtureMode({ fresh: false, reuseDb: true, dropExisting: false })).toBe("reuse")
  })

  test("--drop-existing is the explicit authorization to reseed a pre-existing database", () => {
    expect(fixtureMode({ fresh: false, reuseDb: false, dropExisting: true })).toBe("seed")
  })

  test("the refusal names the database and both ways forward", () => {
    const message = existingDbRefusal("realdb")
    expect(message).toContain("realdb")
    expect(message).toContain("--reuse-db")
    expect(message).toContain("--drop-existing")
  })
})

describe("bin/bench-usage exit-drop gate", () => {
  test("a fresh run still drops its own database at the end", () => {
    expect(dropsOnExit({ fresh: true, dropExisting: false, keepDb: false })).toBe(true)
  })

  test("a pre-existing database survives the run unless --drop-existing authorized it", () => {
    expect(dropsOnExit({ fresh: false, dropExisting: false, keepDb: false })).toBe(false)
    expect(dropsOnExit({ fresh: false, dropExisting: true, keepDb: false })).toBe(true)
  })

  test("--keep-db beats every drop, fresh or authorized", () => {
    expect(dropsOnExit({ fresh: true, dropExisting: false, keepDb: true })).toBe(false)
    expect(dropsOnExit({ fresh: false, dropExisting: true, keepDb: true })).toBe(false)
  })
})

describe("bin/bench-usage arguments", () => {
  test("--drop-existing defaults off — destruction is opt-in, never opt-out", () => {
    expect(DEFAULTS.dropExisting).toBe(false)
    expect(parseArgs([]).dropExisting).toBe(false)
  })

  test("takes --drop-existing by name", () => {
    expect(parseArgs(["--drop-existing"]).dropExisting).toBe(true)
  })

  test("USAGE documents the flag, or the authorization is undiscoverable", () => {
    expect(USAGE).toContain("--drop-existing")
  })
})

const databaseUrl = process.env.DATABASE_URL ?? ""

describe.skipIf(databaseUrl === "")("bin/bench-usage against a real pre-existing database", () => {
  const REPO_ROOT = resolve(import.meta.dir, "../../../..")
  const HARNESS = join(REPO_ROOT, "apps/api/bench/usage-summary.ts")
  const created: string[] = []
  let adminHandle: ReturnType<typeof createDatabase> | undefined

  const admin = (): ReturnType<typeof createDatabase> => {
    adminHandle ??= createDatabase({ url: databaseUrl, maxConnections: 1 })
    return adminHandle
  }

  const urlFor = (name: string): string => {
    const url = new URL(databaseUrl)
    url.pathname = `/${name}`
    return url.toString()
  }

  const uniqueName = (): string => {
    const name = `usage_bench_gate_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`
    created.push(name)
    return name
  }

  const databaseExists = async (name: string): Promise<boolean> => {
    const rows = await admin().sql.unsafe("select 1 from pg_database where datname = $1", [name])
    return rows.length > 0
  }

  afterAll(async () => {
    // Every database this file named is throwaway: whatever a failed assertion left
    // behind goes here. The harness drops its own authorized databases itself.
    for (const name of created) {
      try {
        await adminHandle?.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } catch {
        // Cleanup is best-effort; the assertions above are the verdict.
      }
    }
    await adminHandle?.close()
  })

  const runHarness = async (
    dbName: string,
    flags: string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> => {
    const child = Bun.spawn(["bun", HARNESS, "--url", databaseUrl, "--db", dbName, ...flags], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { stdout, stderr, exitCode: await child.exited }
  }

  test("a run pointed at a pre-existing database refuses it whole: no truncate, no drop", async () => {
    const name = uniqueName()
    await admin().sql.unsafe(`create database "${name}"`)
    const probe = createDatabase({ url: urlFor(name), maxConnections: 1 })
    await probe.sql.unsafe("create table sentinel (note text)")
    await probe.sql.unsafe("insert into sentinel (note) values ('survived')")
    await probe.close()

    const ran = await runHarness(name, [])

    expect(ran.exitCode).not.toBe(0)
    expect(ran.stderr).toContain(name)
    expect(ran.stderr).toContain("--reuse-db")
    expect(ran.stderr).toContain("--drop-existing")
    expect(await databaseExists(name)).toBe(true)
    const check = createDatabase({ url: urlFor(name), maxConnections: 1 })
    const rows = await check.sql.unsafe("select note from sentinel")
    await check.close()
    expect(rows.map((row) => row.note)).toEqual(["survived"])
  }, 60_000)

  test("--drop-existing drops the pre-existing database it was authorized on", async () => {
    const name = uniqueName()
    await admin().sql.unsafe(`create database "${name}"`)

    // --reuse-db skips the issue-#250-scale seed; the drop under test is the `finally`
    // block's, and it does not care how the run spent its middle.
    const ran = await runHarness(name, ["--drop-existing", "--reuse-db", "--no-explain"])

    expect(ran.exitCode).toBe(0)
    expect(await databaseExists(name)).toBe(false)
  }, 240_000)
})
