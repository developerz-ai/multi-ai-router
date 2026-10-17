import { describe, expect, test } from "bun:test"
import {
  existingDbRefusal,
  type FixtureMode,
  type LifecycleSql,
  withFixtureDatabase,
} from "../../../bench/usage-summary-lifecycle"

/**
 * The #286 ordering pins, driven through `withFixtureDatabase` against an injected
 * executor: no database, no subprocess, no timing.
 *
 * The prod fingerprint is a race — another actor creates the `--db` name between the
 * harness's `pg_database` probe and its `create database` — so the create fails after
 * a clean probe, and the exit `finally` must read the database as "not ours" and drop
 * nothing. The pure truth table in the integration file pins each gate alone; this
 * file pins their composition in the order the harness runs them, including the
 * authorized-reseed path (`--drop-existing` alone) no live leg exercises.
 */

interface FakeCluster {
  readonly sql: LifecycleSql
  readonly statements: string[]
  readonly drops: () => string[]
}

/**
 * A one-database cluster. `existsAtProbe` is what the `pg_database` probe reports;
 * `createFails` plays the racer that got the name first — the create is rejected
 * even though the probe was clean.
 */
function fakeCluster(options: { existsAtProbe: boolean; createFails?: boolean }): FakeCluster {
  const statements: string[] = []
  const sql: LifecycleSql = {
    unsafe: async (query: string, params?: string[]): Promise<unknown[]> => {
      statements.push(query)
      if (query.startsWith("select 1 from pg_database")) {
        expect(params).toEqual(["raced_bench"])
        return options.existsAtProbe ? [{ one: 1 }] : []
      }
      if (query.startsWith("create database")) {
        if (options.existsAtProbe || options.createFails === true)
          throw new Error('duplicate_database: database "raced_bench" already exists')
        return []
      }
      if (query.startsWith("drop database")) return []
      throw new Error(`unexpected statement: ${query}`)
    },
  }
  return {
    sql,
    statements,
    drops: () => statements.filter((s) => s.startsWith("drop database")),
  }
}

interface SeamFlags {
  reuseDb?: boolean
  dropExisting?: boolean
  keepDb?: boolean
}

function run(cluster: FakeCluster, flags: SeamFlags = {}) {
  const modes: FixtureMode[] = []
  const promise = withFixtureDatabase({
    sql: cluster.sql,
    name: "raced_bench",
    reuseDb: flags.reuseDb ?? false,
    dropExisting: flags.dropExisting ?? false,
    keepDb: flags.keepDb ?? false,
    body: async (mode) => {
      modes.push(mode)
    },
  })
  return { promise, modes }
}

describe("withFixtureDatabase ordering (#286)", () => {
  test("a create that fails after a clean probe is never claimed — the exit drops nothing", async () => {
    const cluster = fakeCluster({ existsAtProbe: false, createFails: true })
    const { promise, modes } = run(cluster)

    await expect(promise).rejects.toThrow("already exists")

    // The racer's database is not this run's to destroy: the body never ran, and
    // the `finally` issued no drop.
    expect(modes).toEqual([])
    expect(cluster.drops()).toEqual([])
    expect(cluster.statements.filter((s) => s.startsWith("create database"))).toHaveLength(1)
  })

  test("a raced create under --drop-existing still drops nothing — the flag authorizes only a database present at the probe", async () => {
    const cluster = fakeCluster({ existsAtProbe: false, createFails: true })
    const { promise, modes } = run(cluster, { dropExisting: true })

    await expect(promise).rejects.toThrow("already exists")

    // `--drop-existing` authorizes dropping a database that EXISTED AT THE PROBE.
    // This name was absent at the probe and appeared afterwards, created by the
    // racer, so this run's create failed: `fresh` is false, the body never ran,
    // and the exit `finally` must not read the flag as a license to force-drop
    // the other actor's database.
    expect(modes).toEqual([])
    expect(cluster.drops()).toEqual([])
    expect(cluster.statements.filter((s) => s.startsWith("create database"))).toHaveLength(1)
  })

  test("a clean probe and a successful create still seed and drop their own database", async () => {
    const cluster = fakeCluster({ existsAtProbe: false })
    const { promise, modes } = run(cluster)

    await promise

    expect(modes).toEqual(["seed"])
    expect(cluster.drops()).toHaveLength(1)
  })

  test("a body that fails mid-run still drops the database this run created", async () => {
    const cluster = fakeCluster({ existsAtProbe: false })
    const failing = withFixtureDatabase({
      sql: cluster.sql,
      name: "raced_bench",
      reuseDb: false,
      dropExisting: false,
      keepDb: false,
      body: async () => {
        throw new Error("bench body blew up")
      },
    })

    await expect(failing).rejects.toThrow("bench body blew up")
    expect(cluster.drops()).toHaveLength(1)
  })

  test("a pre-existing name with no flag is refused — no create, no drop, no body", async () => {
    const cluster = fakeCluster({ existsAtProbe: true })
    const { promise, modes } = run(cluster)

    await expect(promise).rejects.toThrow(existingDbRefusal("raced_bench"))

    expect(modes).toEqual([])
    expect(cluster.statements.some((s) => s.startsWith("create database"))).toBe(false)
    expect(cluster.drops()).toEqual([])
  })

  test("--drop-existing alone reseeds the pre-existing database and drops it at exit", async () => {
    const cluster = fakeCluster({ existsAtProbe: true })
    const { promise, modes } = run(cluster, { dropExisting: true })

    await promise

    // The authorized-reseed path: the body seeds, no create is issued (it exists),
    // and the exit drop fires under the authorization.
    expect(modes).toEqual(["seed"])
    expect(cluster.statements.some((s) => s.startsWith("create database"))).toBe(false)
    expect(cluster.drops()).toHaveLength(1)
  })

  test("--reuse-db --drop-existing: reuse wins the seed, drop still authorized (#286)", async () => {
    const cluster = fakeCluster({ existsAtProbe: true })
    const { promise, modes } = run(cluster, { reuseDb: true, dropExisting: true })

    await promise

    expect(modes).toEqual(["reuse"])
    expect(cluster.drops()).toHaveLength(1)
  })

  test("--reuse-db alone benchmarks as-is and leaves the database standing", async () => {
    const cluster = fakeCluster({ existsAtProbe: true })
    const { promise, modes } = run(cluster, { reuseDb: true })

    await promise

    expect(modes).toEqual(["reuse"])
    expect(cluster.drops()).toEqual([])
  })

  test("--keep-db keeps even the database this run created", async () => {
    const cluster = fakeCluster({ existsAtProbe: false })
    const { promise, modes } = run(cluster, { keepDb: true })

    await promise

    expect(modes).toEqual(["seed"])
    expect(cluster.statements.some((s) => s.startsWith("create database"))).toBe(true)
    expect(cluster.drops()).toEqual([])
  })
})
