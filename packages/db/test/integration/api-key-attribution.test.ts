import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { routerKeyDisplayPrefix } from "@multi-ai-router/core"
import { createDatabase, type DatabaseHandle } from "../../src/client"
import { defaultMigrationsFolder, runMigrations } from "../../src/migrate"
import { createApiKeyRepository } from "../../src/repositories/api-key-repository"

/**
 * Attribution columns against a real PostgreSQL 16+: what migration 0033 leaves
 * behind on pre-existing rows, and that the repository's owner/tool filters are
 * exact-match predicates the planner can use. Own database, dropped afterwards —
 * a shared development database must look untouched.
 */
// `DATABASE_URL` and nothing else: `bin/check` refuses to run without one and
// `bin/test` names this file when it skips, so the skip can no longer be silent.
const url = process.env.DATABASE_URL ?? ""
const runnable = url !== ""

const databaseName = `key_attr_${crypto.randomUUID().replaceAll("-", "")}`

let handle: DatabaseHandle | undefined
let admin: DatabaseHandle | undefined

beforeAll(async () => {
  if (!runnable) return
  admin = createDatabase({ url, maxConnections: 1 })
  await admin.sql.unsafe(`create database "${databaseName}"`)
  const uri = new URL(url)
  uri.pathname = `/${databaseName}`
  await runMigrations({ url: uri.toString(), migrationsFolder: defaultMigrationsFolder() })
  handle = createDatabase({ url: uri.toString(), maxConnections: 2 })
  // Creating a database and running every migration outlasts bun's 5 s hook default on a busy box.
}, 60_000)

afterAll(async () => {
  await handle?.close()
  await admin?.sql.unsafe(`drop database if exists "${databaseName}" with (force)`)
  await admin?.close()
}, 30_000)

describe.skipIf(!runnable)("api key attribution against a live database", () => {
  test("a row inserted with only pre-migration columns lists with null labels and still verifies", async () => {
    if (handle === undefined) return
    const repository = createApiKeyRepository(handle.db)
    const value = "mar_live_pre0migration00key0value"
    const prefix = routerKeyDisplayPrefix(value) ?? value.slice(0, 17)

    // Exactly the INSERT a pre-0033 router could issue: no attribution column named.
    await handle.sql.unsafe(
      `insert into api_keys (name, value, prefix) values ('legacy-laptop', 'v1.k1.old', $1)`,
      [prefix],
    )

    const rows = await repository.list()
    const legacy = rows.find((row) => row.name === "legacy-laptop")
    expect(legacy?.owner).toBeNull()
    expect(legacy?.ownerKind).toBeNull()
    expect(legacy?.tool).toBeNull()
    expect(legacy?.purpose).toBeNull()

    const usable = await repository.findUsableByPrefix(prefix, new Date())
    expect(usable.map((row) => row.name)).toEqual(["legacy-laptop"])

    // A NULL label is not an empty string: the owner filter must not match it.
    expect((await repository.list({ owner: "legacy" })).map((row) => row.name)).toEqual([])
  })

  test("labels round-trip through create and update, and null clears", async () => {
    if (handle === undefined) return
    const repository = createApiKeyRepository(handle.db)

    const created = await repository.create({
      name: "ci-agent-3",
      value: "v1.k1.a",
      prefix: "mar_live_createme0",
      owner: "ci",
      ownerKind: "service",
      tool: "aider",
      purpose: "nightly evals",
    })
    expect(created).toMatchObject({
      owner: "ci",
      ownerKind: "service",
      tool: "aider",
      purpose: "nightly evals",
    })

    const cleared = await repository.update(created.id, { owner: null, tool: null }, new Date())
    expect(cleared).toMatchObject({ owner: null, tool: null, ownerKind: "service" })

    // Absent keys stay absent — only an explicit null clears.
    const renamed = await repository.update(created.id, { name: "ci-agent-4" }, new Date())
    expect(renamed?.ownerKind).toBe("service")
  })

  test("the owner and tool filters are exact matches and combine", async () => {
    if (handle === undefined) return
    const repository = createApiKeyRepository(handle.db)

    for (const input of [
      { name: "f-a", value: "v1.k1.b", prefix: "mar_live_filtera00", owner: "seb", tool: "cc" },
      { name: "f-b", value: "v1.k1.c", prefix: "mar_live_filterb00", owner: "seb", tool: "aider" },
      { name: "f-c", value: "v1.k1.d", prefix: "mar_live_filterc00", tool: "aider" },
    ]) {
      await repository.create(input)
    }

    const names = (rows: Awaited<ReturnType<typeof repository.list>>) =>
      rows.map((row) => row.name).sort()

    expect(names(await repository.list({ owner: "seb" }))).toEqual(["f-a", "f-b"])
    expect(names(await repository.list({ tool: "aider" }))).toEqual(["f-b", "f-c"])
    expect(names(await repository.list({ owner: "seb", tool: "aider" }))).toEqual(["f-b"])
    expect(names(await repository.list({ owner: "se" }))).toEqual([])
  })
})
