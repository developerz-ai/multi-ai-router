import { expect, test } from "bun:test"
import { createSdkTranscripts } from "../../../src/providers/claude-sdk/transcripts"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"

const accountId = "11111111-1111-4111-8111-111111111111"
const sessionId = "22222222-2222-4222-8222-222222222222"

test("survey and removal retain account ownership across awaited filesystem work", async () => {
  let owned = false
  let acquisitions = 0
  let removed = 0
  const transcripts = createSdkTranscripts({
    root: "/offline/accounts",
    withAccountOwner: async (_id, task) => {
      acquisitions++
      owned = true
      try {
        return await task()
      } finally {
        owned = false
      }
    },
    fs: {
      list: async (path) => {
        if (path === "/offline/accounts") return [{ name: accountId, kind: "dir" }]
        expect(owned).toBe(true)
        await Promise.resolve()
        expect(owned).toBe(true)
        return path.endsWith("projects")
          ? [{ name: "project", kind: "dir" }]
          : [{ name: `${sessionId}.jsonl`, kind: "file" }]
      },
      stat: async (path) => {
        expect(owned).toBe(true)
        return path.endsWith(".jsonl") ? { kind: "file", bytes: 1, changedAtMs: 0 } : null
      },
      removeFile: async () => {
        expect(owned).toBe(true)
        removed++
      },
      removeDir: async () => {
        throw new Error("no directory artifact")
      },
    },
  })
  const entries = await transcripts.survey()
  expect(entries).toHaveLength(1)
  const entry = entries[0]
  if (entry === undefined) throw new Error("missing transcript")
  await transcripts.remove(entry)
  expect({ owned, acquisitions, removed }).toEqual({ owned: false, acquisitions: 2, removed: 1 })
})

test("tombstoned account skips filesystem access safely", async () => {
  const transcripts = createSdkTranscripts({
    root: "/offline/accounts",
    withAccountOwner: async () => {
      throw new UpstreamAdmissionRefused()
    },
    fs: {
      list: async (path) => {
        if (path === "/offline/accounts") return [{ name: accountId, kind: "dir" }]
        throw new Error("must not access tombstoned account")
      },
      stat: async () => {
        throw new Error("must not stat")
      },
      removeFile: async () => {
        throw new Error("must not remove")
      },
      removeDir: async () => {
        throw new Error("must not remove")
      },
    },
  })
  expect(await transcripts.survey()).toEqual([])
  expect(
    await transcripts.remove({
      accountId,
      sessionId,
      project: "project",
      transcript: { bytes: 1 },
      sessionDir: false,
      changedAtMs: 0,
    }),
  ).toBe(false)
})

test("sweep admission refusal reports deferred without removed sessions or bytes", async () => {
  const { createTranscriptSweepTask } = await import(
    "../../../src/scheduler/tasks/sdk-transcript-sweep"
  )
  const { silentLogger } = await import("../scheduler/fixtures")
  let revoked = false
  let fsCalls = 0
  const transcripts = createSdkTranscripts({
    root: "/offline/accounts",
    withAccountOwner: async (_id, task) => {
      if (revoked) throw new UpstreamAdmissionRefused()
      return task()
    },
    fs: {
      list: async (path) => {
        if (path === "/offline/accounts") return [{ name: accountId, kind: "dir" }]
        fsCalls++
        return path.endsWith("projects")
          ? [{ name: "project", kind: "dir" }]
          : [{ name: `${sessionId}.jsonl`, kind: "file" }]
      },
      stat: async () => {
        fsCalls++
        return { kind: "file", bytes: 999, changedAtMs: 0 }
      },
      removeFile: async () => {
        throw new Error("must not remove after revocation")
      },
      removeDir: async () => {
        throw new Error("must not remove after revocation")
      },
    },
  })
  const entries = await transcripts.survey()
  const before = fsCalls
  revoked = true
  const summaries: unknown[] = []
  const task = createTranscriptSweepTask({
    transcripts: { ...transcripts, survey: async () => entries },
    retentionMs: 1,
    intervalMs: 1000,
    batchSize: 1,
  })
  expect(
    await task.run({
      now: new Date(10000),
      signal: new AbortController().signal,
      logger: {
        ...silentLogger(),
        info: (_message, fields) => {
          summaries.push(fields)
        },
      },
    }),
  ).toEqual({ outcome: "partial", itemsProcessed: 0 })
  expect(fsCalls).toBe(before)
  expect(summaries).toEqual([expect.objectContaining({ removed: 0, bytes: 0, deferred: 1 })])
})
