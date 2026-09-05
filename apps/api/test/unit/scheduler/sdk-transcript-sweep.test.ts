import { describe, expect, test } from "bun:test"
import type { TranscriptEntry } from "../../../src/providers/claude-sdk/transcripts"
import {
  createTranscriptSweepTask,
  planTranscriptSweep,
} from "../../../src/scheduler/tasks/sdk-transcript-sweep"
import { createMemoryTranscripts } from "../../support/sdk-transcripts"
import { NOW, silentLogger } from "./fixtures"

/**
 * The Agent-SDK transcript sweep.
 *
 * Two things are pinned, from opposite sides. That a transcript nobody has resumed in a day goes —
 * production held a quarter of a gigabyte per account of exactly those. And that nothing else in
 * a `CLAUDE_CONFIG_DIR` is *ever* a candidate: the same directory holds the subscription's live
 * OAuth credentials, and a sweep that could reach them is worse than no sweep. The survey is the
 * only thing that can name a file, so the survey is what the safety tests drive.
 */

const ROOT = "/data/claude"
const ACCOUNT = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const OTHER_ACCOUNT = "8ab4d2c1-6e39-4f70-b512-77c9e0a3d148"
const SESSION = "0f3c9b2e-1111-4222-8333-444455556666"
const OLD_SESSION = "9a9a9a9a-2222-4333-8444-555566667777"
const SLUG = "-data-claude-3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const RETENTION_MS = 24 * 60 * 60 * 1_000
const HOUR_MS = 60 * 60 * 1_000

function agedHours(hours: number): number {
  return NOW.getTime() - hours * HOUR_MS
}

function entry(sessionId: string, hours: number, bytes = 10): TranscriptEntry {
  return {
    accountId: ACCOUNT,
    project: SLUG,
    sessionId,
    transcript: { bytes },
    sessionDir: false,
    changedAtMs: agedHours(hours),
  }
}

function project(account = ACCOUNT): string {
  return `${ROOT}/${account}/projects/${SLUG}`
}

describe("deciding what may go", () => {
  test("a transcript inside the retention window waits, however large", () => {
    const plan = planTranscriptSweep({
      entries: [entry(SESSION, 1, 1_000_000)],
      now: NOW,
      retentionMs: RETENTION_MS,
      limit: 10,
    })

    expect(plan.sweep).toEqual([])
    expect(plan.young).toBe(1)
    expect(plan.bytes).toBe(0)
  })

  test("a transcript past the window is removable, and the bytes are counted", () => {
    const plan = planTranscriptSweep({
      entries: [entry(SESSION, 25, 400)],
      now: NOW,
      retentionMs: RETENTION_MS,
      limit: 10,
    })

    expect(plan.sweep.map((e) => e.sessionId)).toEqual([SESSION])
    expect(plan.bytes).toBe(400)
    expect(plan.remaining).toBe(false)
  })

  test("candidates come oldest first and stop at the batch limit, reporting there is more", () => {
    const plan = planTranscriptSweep({
      entries: [entry(SESSION, 30), entry(OLD_SESSION, 200), entry("third", 48)],
      now: NOW,
      retentionMs: RETENTION_MS,
      limit: 2,
    })

    expect(plan.sweep.map((e) => e.sessionId)).toEqual([OLD_SESSION, "third"])
    expect(plan.remaining).toBe(true)
  })

  test("the window is the injected number, never a constant", () => {
    const plan = planTranscriptSweep({
      entries: [entry(SESSION, 3)],
      now: NOW,
      retentionMs: 2 * HOUR_MS,
      limit: 10,
    })

    expect(plan.sweep).toHaveLength(1)
  })
})

describe("what the survey is allowed to see", () => {
  /** The test this whole sweep exists to pass. */
  test("a credential, a settings file, and the CLI's own state are never candidates", async () => {
    const volume = createMemoryTranscripts(ROOT)
    const ancient = agedHours(10_000)
    for (const name of [
      ".credentials.json",
      ".claude.json",
      "settings.json",
      "policy-limits.json",
      "remote-settings.json",
      "history.jsonl",
      "sessions/12345.json",
      "sessions/12345.abc.key",
      "backups/.claude.json.backup.1",
      "jobs/whatever.json",
      "telemetry/events.jsonl",
      `projects/${SLUG}/memory/MEMORY.md`,
      `projects/${SLUG}/agent-deadbeef.jsonl`,
      `projects/${SLUG}/notes.jsonl`,
      `projects/${SLUG}/${SESSION}.jsonl.bak`,
      // Session artifacts one level too deep are the session directory's, not their own.
      `projects/${SLUG}/${SESSION}/subagents/agent-1.jsonl`,
    ]) {
      volume.place(`${ROOT}/${ACCOUNT}/${name}`, { kind: "file", changedAtMs: ancient, bytes: 5 })
    }
    // And a directory that is not an account at all.
    volume.place(`${ROOT}/lost+found/${SESSION}.jsonl`, { kind: "file", changedAtMs: ancient })

    const entries = await volume.transcripts.survey()

    // The one legitimate candidate that fell out of the list above: the session directory.
    expect(entries.map((e) => [e.sessionId, e.transcript, e.sessionDir])).toEqual([
      [SESSION, null, true],
    ])

    const task = createTranscriptSweepTask({
      transcripts: volume.transcripts,
      retentionMs: RETENTION_MS,
      intervalMs: 1,
      batchSize: 100,
    })
    await task.run({ now: NOW, logger: silentLogger(), signal: new AbortController().signal })

    expect(volume.removals).toEqual([`rm -r ${project()}/${SESSION}`])
    expect(volume.has(`${ROOT}/${ACCOUNT}/.credentials.json`)).toBe(true)
    expect(volume.has(`${ROOT}/${ACCOUNT}/projects/${SLUG}/memory/MEMORY.md`)).toBe(true)
  })

  test("a symlink is not surveyed, and one planted after the survey is not removed", async () => {
    const volume = createMemoryTranscripts(ROOT)
    const ancient = agedHours(100)
    volume.place(`${project()}/${SESSION}.jsonl`, { kind: "link", changedAtMs: ancient })
    volume.place(`${project()}/${OLD_SESSION}`, { kind: "link", changedAtMs: ancient })
    volume.place(`${project()}/${OLD_SESSION}.jsonl`, { kind: "file", changedAtMs: ancient })

    const entries = await volume.transcripts.survey()
    expect(entries.map((e) => [e.sessionId, e.transcript !== null, e.sessionDir])).toEqual([
      [OLD_SESSION, true, false],
    ])

    // The transcript is now a link — swapped in between survey and removal.
    volume.place(`${project()}/${OLD_SESSION}.jsonl`, { kind: "link", changedAtMs: ancient })
    const [only] = entries
    if (only === undefined) throw new Error("expected one entry")
    await volume.transcripts.remove(only)

    expect(volume.removals).toEqual([])
  })

  test("a session is dated by its newest artifact, so a directory still in use keeps its transcript", async () => {
    const volume = createMemoryTranscripts(ROOT)
    volume.place(`${project()}/${SESSION}.jsonl`, { kind: "file", changedAtMs: agedHours(40) })
    volume.place(`${project()}/${SESSION}`, { kind: "dir", changedAtMs: agedHours(1) })

    const [entry] = await volume.transcripts.survey()

    expect(entry?.changedAtMs).toBe(agedHours(1))
  })

  test("removal rebuilds the path from validated parts and refuses anything else", async () => {
    const volume = createMemoryTranscripts(ROOT)
    await expect(
      volume.transcripts.remove({
        accountId: "../..",
        project: SLUG,
        sessionId: SESSION,
        transcript: null,
        sessionDir: true,
        changedAtMs: 0,
      }),
    ).rejects.toThrow("refused")
    await expect(
      volume.transcripts.remove({
        accountId: ACCOUNT,
        project: "../../etc",
        sessionId: SESSION,
        transcript: null,
        sessionDir: true,
        changedAtMs: 0,
      }),
    ).rejects.toThrow("refused")
    expect(volume.removals).toEqual([])
  })
})

describe("the task", () => {
  function volumeWithBacklog() {
    const volume = createMemoryTranscripts(ROOT)
    volume.place(`${project()}/${OLD_SESSION}.jsonl`, {
      kind: "file",
      changedAtMs: agedHours(200),
      bytes: 700,
    })
    volume.place(`${project()}/${OLD_SESSION}/tool-results/a.txt`, {
      kind: "file",
      changedAtMs: agedHours(200),
    })
    volume.place(`${project()}/${SESSION}.jsonl`, {
      kind: "file",
      changedAtMs: agedHours(30),
      bytes: 300,
    })
    volume.place(`${project(OTHER_ACCOUNT)}/${SESSION}.jsonl`, {
      kind: "file",
      changedAtMs: agedHours(2),
    })
    return volume
  }

  test("removes what is past the window across every account, and reports the bytes", async () => {
    const volume = volumeWithBacklog()
    const lines: Record<string, unknown>[] = []
    const task = createTranscriptSweepTask({
      transcripts: volume.transcripts,
      retentionMs: RETENTION_MS,
      intervalMs: 1,
      batchSize: 100,
    })

    const result = await task.run({
      now: NOW,
      signal: new AbortController().signal,
      logger: {
        ...silentLogger(),
        info: (_msg: string, fields?: Record<string, unknown>) => {
          lines.push(fields ?? {})
        },
      },
    })

    expect(result).toEqual({ outcome: "success", itemsProcessed: 2 })
    expect(volume.removals).toEqual([
      `unlink ${project()}/${OLD_SESSION}.jsonl`,
      `rm -r ${project()}/${OLD_SESSION}`,
      `unlink ${project()}/${SESSION}.jsonl`,
    ])
    expect(volume.has(`${project(OTHER_ACCOUNT)}/${SESSION}.jsonl`)).toBe(true)
    expect(lines[0]).toMatchObject({ surveyed: 3, removed: 2, bytes: 1_000, withinRetention: 1 })
    // Never a session id in the log: a transcript's name is a conversation's resume token.
    expect(JSON.stringify(lines)).not.toContain(OLD_SESSION)
  })

  test("a batch smaller than the backlog is partial, and the next tick continues", async () => {
    const volume = volumeWithBacklog()
    const task = createTranscriptSweepTask({
      transcripts: volume.transcripts,
      retentionMs: RETENTION_MS,
      intervalMs: 1,
      batchSize: 1,
    })
    const ctx = { now: NOW, logger: silentLogger(), signal: new AbortController().signal }

    expect(await task.run(ctx)).toEqual({ outcome: "partial", itemsProcessed: 1 })
    expect(await task.run(ctx)).toEqual({ outcome: "success", itemsProcessed: 1 })
    expect(await task.run(ctx)).toEqual({ outcome: "success", itemsProcessed: 0 })
  })

  test("an aborted run stops between sessions and reports partial", async () => {
    const volume = volumeWithBacklog()
    const controller = new AbortController()
    controller.abort()
    const task = createTranscriptSweepTask({
      transcripts: volume.transcripts,
      retentionMs: RETENTION_MS,
      intervalMs: 1,
      batchSize: 100,
    })

    const result = await task.run({ now: NOW, logger: silentLogger(), signal: controller.signal })

    expect(result).toEqual({ outcome: "partial", itemsProcessed: 0 })
    expect(volume.removals).toEqual([])
  })

  test("a removal that throws fails the run, keeps the count, and names the cause", async () => {
    const volume = volumeWithBacklog()
    const task = createTranscriptSweepTask({
      transcripts: {
        root: ROOT,
        survey: volume.transcripts.survey,
        remove: async () => {
          throw new Error("EACCES: read-only volume")
        },
      },
      retentionMs: RETENTION_MS,
      intervalMs: 1,
      batchSize: 100,
    })

    const result = await task.run({
      now: NOW,
      logger: silentLogger(),
      signal: new AbortController().signal,
    })

    expect(result.outcome).toBe("failed")
    expect(result.itemsProcessed).toBe(0)
    expect(result.error).toContain("EACCES")
  })
})
