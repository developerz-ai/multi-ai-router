import { describe, expect, test } from "bun:test"
import type { ConfigDirEntry } from "../../../src/providers/claude-sdk/config-dir"
import {
  createConfigDirReapTask,
  planConfigDirReap,
} from "../../../src/scheduler/tasks/config-dir-reap"
import { createMemoryConfigDirs } from "../../support/config-dirs"
import { NOW, silentLogger } from "./fixtures"

/**
 * The orphaned-`CLAUDE_CONFIG_DIR` reaper.
 *
 * Every assertion here is about the same thing from one side or the other: **a directory holds a
 * live subscription's cleartext OAuth credentials**, so leaving an abandoned one is a credential
 * nothing will rotate, and removing a live one logs a working account out for good. The plan is a
 * pure function precisely so both halves can be pinned without a disk.
 */

const ROOT = "/data/claude"
const LIVE = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const ORPHAN = "8ab4d2c1-6e39-4f70-b512-77c9e0a3d148"
const OTHER_ORPHAN = "c0ffee11-2222-4333-8444-555566667777"
const GRACE_MS = 24 * 60 * 60 * 1_000
const HOUR_MS = 60 * 60 * 1_000

/** Epoch ms `hours` before the tick's clock. */
function agedHours(hours: number): number {
  return NOW.getTime() - hours * HOUR_MS
}

function entry(name: string, hours: number, accountId: string | null = name): ConfigDirEntry {
  return { name, accountId, changedAtMs: agedHours(hours) }
}

function plan(entries: readonly ConfigDirEntry[], liveIds: readonly string[], limit = 100) {
  return planConfigDirReap({
    entries,
    liveAccountIds: new Set(liveIds),
    now: NOW,
    graceMs: GRACE_MS,
    limit,
  })
}

describe("deciding what may go", () => {
  test("a directory an account still names is never a candidate, however old", () => {
    const result = plan([entry(LIVE, 10_000)], [LIVE])
    expect(result.reap).toEqual([])
    expect(result.claimed).toBe(1)
  })

  test("an unclaimed directory inside the grace window waits — the row may still be landing", () => {
    // `provision` runs before the insert, so a directory younger than the grace is one an account
    // may be about to claim. Deleting it would be deleting a login nobody has finished making.
    const result = plan([entry(ORPHAN, 1)], [])
    expect(result.reap).toEqual([])
    expect(result.young).toBe(1)
  })

  test("an unclaimed directory past the grace window is removable", () => {
    const result = plan([entry(ORPHAN, 25)], [LIVE])
    expect(result.reap.map((dir) => dir.accountId)).toEqual([ORPHAN])
    expect(result.claimed).toBe(0)
    expect(result.young).toBe(0)
  })

  test("a name that is not an account id is not this router's to remove", () => {
    const result = plan([entry("lost+found", 900, null), entry(".tmp", 900, null)], [])
    expect(result.reap).toEqual([])
    expect(result.foreign).toBe(2)
  })

  test("a case variant of a live account id is read as claimed, never gambled on", () => {
    const shouty = LIVE.toUpperCase()
    const result = plan([entry(shouty, 900)], [LIVE])
    expect(result.reap).toEqual([])
    expect(result.claimed).toBe(1)
  })

  test("candidates come oldest first and stop at the batch limit, reporting there is more", () => {
    const result = plan([entry(ORPHAN, 30), entry(OTHER_ORPHAN, 90)], [], 1)
    expect(result.reap.map((dir) => dir.accountId)).toEqual([OTHER_ORPHAN])
    expect(result.remaining).toBe(true)

    const drained = plan([entry(ORPHAN, 30), entry(OTHER_ORPHAN, 90)], [], 2)
    expect(drained.reap.map((dir) => dir.accountId)).toEqual([OTHER_ORPHAN, ORPHAN])
    expect(drained.remaining).toBe(false)
  })

  test("exactly at the grace boundary the directory stays — the cutoff is strict", () => {
    expect(plan([entry(ORPHAN, 24)], []).reap).toEqual([])
    expect(plan([entry(ORPHAN, 24.001)], []).reap).toHaveLength(1)
  })
})

interface Harness {
  readonly volume: ReturnType<typeof createMemoryConfigDirs>
  readonly order: string[]
  readonly task: ReturnType<typeof createConfigDirReapTask>
}

function harness(liveIds: readonly string[], batchSize = 100): Harness {
  const volume = createMemoryConfigDirs(ROOT)
  const order: string[] = []
  const task = createConfigDirReapTask({
    configDirs: {
      root: volume.dirs.root,
      list: async () => {
        order.push("list-dirs")
        return volume.dirs.list()
      },
      remove: (id) => {
        order.push(`remove ${id}`)
        return volume.dirs.remove(id)
      },
    },
    accounts: {
      listIds: async () => {
        order.push("list-account-ids")
        return [...liveIds]
      },
    },
    graceMs: GRACE_MS,
    intervalMs: 6 * HOUR_MS,
    batchSize,
  })
  return { volume, order, task }
}

function tick(task: Harness["task"], signal = new AbortController().signal) {
  return task.run({ now: NOW, logger: silentLogger(), signal })
}

describe("the reap task", () => {
  test("removes the abandoned directory and leaves the live and the foreign ones alone", async () => {
    const { volume, task } = harness([LIVE])
    volume.place(LIVE, agedHours(900))
    volume.place(ORPHAN, agedHours(900))
    volume.place("lost+found", agedHours(900))

    const result = await tick(task)

    expect(result.outcome).toBe("success")
    expect(result.itemsProcessed).toBe(1)
    expect(volume.names().sort()).toEqual([LIVE, "lost+found"])
  })

  test("surveys the volume before it reads the accounts, so a new row can only save a directory", async () => {
    // A directory minted after the survey cannot be in it; a row inserted after the survey is
    // still read. The order only ever shrinks the suspect set — reversing it would grow it.
    const { volume, task, order } = harness([LIVE])
    volume.place(ORPHAN, agedHours(900))

    await tick(task)

    expect(order).toEqual(["list-dirs", "list-account-ids", `remove ${ORPHAN}`])
  })

  test("removes by account id, so the path can only ever be one under the root", async () => {
    const { volume, task } = harness([])
    volume.place(ORPHAN, agedHours(900))

    await tick(task)

    expect(volume.calls).toContain(`rm ${ROOT}/${ORPHAN}`)
  })

  test("a volume with nothing abandoned on it is a successful no-op", async () => {
    const { volume, task } = harness([LIVE])
    volume.place(LIVE, agedHours(900))

    const result = await tick(task)

    expect(result).toEqual({ outcome: "success", itemsProcessed: 0 })
    expect(volume.names()).toEqual([LIVE])
  })

  test("the batch limit makes a tick partial, and the next tick finishes the backlog", async () => {
    const { volume, task } = harness([], 1)
    volume.place(ORPHAN, agedHours(30))
    volume.place(OTHER_ORPHAN, agedHours(90))

    const first = await tick(task)
    expect(first.outcome).toBe("partial")
    expect(first.itemsProcessed).toBe(1)
    // Oldest first: the one that has been unclaimed longest goes first.
    expect(volume.names()).toEqual([ORPHAN])

    const second = await tick(task)
    expect(second.outcome).toBe("success")
    expect(second.itemsProcessed).toBe(1)
    expect(volume.names()).toEqual([])
  })

  test("shutdown mid-batch stops between removals and reports partial, never failed", async () => {
    const { volume, task } = harness([])
    volume.place(ORPHAN, agedHours(30))
    volume.place(OTHER_ORPHAN, agedHours(90))
    const aborted = new AbortController()
    aborted.abort()

    const result = await tick(task, aborted.signal)

    expect(result.outcome).toBe("partial")
    expect(result.itemsProcessed).toBe(0)
    expect(volume.names().sort()).toEqual([OTHER_ORPHAN, ORPHAN].sort())
  })

  test("a removal that throws fails the run but keeps the count of what already went", async () => {
    const volume = createMemoryConfigDirs(ROOT)
    volume.place(ORPHAN, agedHours(30))
    volume.place(OTHER_ORPHAN, agedHours(90))

    let removed = 0
    const task = createConfigDirReapTask({
      configDirs: {
        root: volume.dirs.root,
        list: () => volume.dirs.list(),
        remove: async (id) => {
          removed += 1
          if (removed === 2) throw new Error("EACCES: permission denied")
          await volume.dirs.remove(id)
        },
      },
      accounts: { listIds: async () => [] },
      graceMs: GRACE_MS,
      intervalMs: 6 * HOUR_MS,
      batchSize: 100,
    })

    const result = await tick(task)

    expect(result.outcome).toBe("failed")
    expect(result.itemsProcessed).toBe(1)
    expect(result.error).toContain("EACCES")
  })

  test("every removal is logged with the account whose credentials went", async () => {
    const lines: string[] = []
    const volume = createMemoryConfigDirs(ROOT)
    volume.place(ORPHAN, agedHours(48))
    const task = createConfigDirReapTask({
      configDirs: { root: volume.dirs.root, list: volume.dirs.list, remove: volume.dirs.remove },
      accounts: { listIds: async () => [] },
      graceMs: GRACE_MS,
      intervalMs: 6 * HOUR_MS,
      batchSize: 100,
    })

    await task.run({
      now: NOW,
      logger: {
        debug: () => undefined,
        info: (message) => lines.push(`info ${message}`),
        warn: (message) => lines.push(`warn ${message}`),
        error: () => undefined,
        child: () => {
          throw new Error("unused")
        },
      },
      signal: new AbortController().signal,
    })

    expect(lines).toEqual(["warn orphaned claude config directory removed", "info config dir reap"])
  })
})
