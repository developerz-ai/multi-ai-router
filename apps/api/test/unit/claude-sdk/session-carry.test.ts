import { describe, expect, test } from "bun:test"
import { posix } from "node:path"
import { type CarryFs, createSessionCarrier } from "../../../src/providers/claude-sdk/session-carry"
import { UpstreamAdmissionRefused } from "../../../src/providers/upstream-admission"

/**
 * Carrying one SDK transcript between two Accounts' config directories (`session-carry.ts`).
 *
 * The directories hold live credentials, so what is asserted is mostly what is **not** done: no
 * file but `<uuid>.jsonl` is read, a link is never followed, nothing is written outside the target
 * Account's `projects/`, and both sides run under their Account's owner hold.
 */

const ROOT = "/data/claude"
const FROM = "11111111-1111-4111-8111-111111111111"
const TO = "22222222-2222-4222-8222-222222222222"
const SESSION = "33333333-3333-4333-8333-333333333333"

type Node = { kind: "dir" } | { kind: "file"; text: string } | { kind: "link" }

/** A filesystem in a map. `other` is a link, which every call here must refuse to traverse. */
function memoryFs(seed: Record<string, Node>) {
  const nodes = new Map<string, Node>(Object.entries(seed))
  const reads: string[] = []
  const fs: CarryFs = {
    list: async (path) =>
      [...nodes.entries()]
        .filter(([child]) => posix.dirname(child) === path)
        .map(([child, node]) => ({
          name: posix.basename(child),
          kind: node.kind === "link" ? "other" : node.kind,
        })),
    stat: async (path) => {
      const node = nodes.get(path)
      if (node === undefined || node.kind === "link") return null
      return {
        kind: node.kind,
        changedAtMs: 0,
        bytes: node.kind === "file" ? Buffer.byteLength(node.text) : 0,
      }
    },
    read: async (path) => {
      reads.push(path)
      const node = nodes.get(path)
      if (node?.kind !== "file") throw new Error("not a regular file")
      return node.text
    },
    ensureDir: async (path) => {
      const node = nodes.get(path)
      if (node === undefined) nodes.set(path, { kind: "dir" })
      else if (node.kind !== "dir") throw new Error("not a directory")
    },
    replace: async (path, text) => {
      nodes.set(path, { kind: "file", text })
    },
  }
  return { fs, nodes, reads }
}

const fromProject = `${ROOT}/${FROM}/projects/-data-claude-${FROM}`
const toProject = `${ROOT}/${TO}/projects/-data-claude-${TO}`
const transcript = [
  JSON.stringify({ type: "user", cwd: `${ROOT}/${FROM}`, sessionId: SESSION }),
  JSON.stringify({ type: "assistant", message: { content: "hi" }, sessionId: SESSION }),
].join("\n")

function seeded(extra: Record<string, Node> = {}) {
  return memoryFs({
    [`${ROOT}/${FROM}`]: { kind: "dir" },
    [`${ROOT}/${FROM}/projects`]: { kind: "dir" },
    [fromProject]: { kind: "dir" },
    [`${fromProject}/${SESSION}.jsonl`]: { kind: "file", text: transcript },
    [`${ROOT}/${FROM}/.credentials.json`]: { kind: "file", text: "SECRET" },
    [`${ROOT}/${TO}`]: { kind: "dir" },
    [`${ROOT}/${TO}/.credentials.json`]: { kind: "file", text: "OTHER-SECRET" },
    ...extra,
  })
}

const input = { fromAccountId: FROM, toAccountId: TO, sdkSessionId: SESSION }

describe("carrying a transcript to another account", () => {
  test("lands at the target's own project slug with the config path rewritten, nothing else", async () => {
    const disk = seeded()
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    const outcome = await carrier.carry(input)

    expect(outcome).toMatchObject({ carried: true })
    const written = disk.nodes.get(`${toProject}/${SESSION}.jsonl`)
    expect(written?.kind).toBe("file")
    const text = written?.kind === "file" ? written.text : ""
    expect(text).toContain(`"cwd":"${ROOT}/${TO}"`)
    expect(text).not.toContain(FROM)
    expect(text).toContain(`"sessionId":"${SESSION}"`)
    // Read exactly one file, and it was the transcript.
    expect(disk.reads).toEqual([`${fromProject}/${SESSION}.jsonl`])
    // Neither credential file was touched.
    expect(disk.nodes.get(`${ROOT}/${TO}/.credentials.json`)).toEqual({
      kind: "file",
      text: "OTHER-SECRET",
    })
  })

  test("each side runs under its own account's owner hold", async () => {
    const disk = seeded()
    const held: string[] = []
    let holding: string | null = null
    const watched: CarryFs = {
      ...disk.fs,
      read: (path) => {
        expect(holding).toBe(FROM)
        return disk.fs.read(path)
      },
      replace: (path, text) => {
        expect(holding).toBe(TO)
        return disk.fs.replace(path, text)
      },
    }
    const carrier = createSessionCarrier({
      root: ROOT,
      maxBytes: 1_000_000,
      fs: watched,
      withAccountOwner: async (id, task) => {
        held.push(id)
        holding = id
        try {
          return await task()
        } finally {
          holding = null
        }
      },
    })

    expect(await carrier.carry(input)).toMatchObject({ carried: true })
    expect(held).toEqual([FROM, TO])
  })

  test("an account being deleted refuses its hold, and nothing is written", async () => {
    const disk = seeded()
    const carrier = createSessionCarrier({
      root: ROOT,
      maxBytes: 1_000_000,
      fs: disk.fs,
      withAccountOwner: async (id, task) => {
        if (id === TO) throw new UpstreamAdmissionRefused()
        return task()
      },
    })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "owner-unavailable" })
    expect(disk.nodes.has(`${toProject}/${SESSION}.jsonl`)).toBe(false)
  })

  test("a transcript that is a link is never followed", async () => {
    const disk = seeded({ [`${fromProject}/${SESSION}.jsonl`]: { kind: "link" } })
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "not-found" })
    expect(disk.reads).toHaveLength(0)
  })

  test("a link where the target's projects directory should be is refused, not written through", async () => {
    const disk = seeded({ [`${ROOT}/${TO}/projects`]: { kind: "link" } })
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    expect(await carrier.carry(input)).toMatchObject({ carried: false, reason: "io-error" })
    expect(disk.nodes.has(`${toProject}/${SESSION}.jsonl`)).toBe(false)
  })

  test("a swept transcript is not found, and the turn will start fresh", async () => {
    const disk = seeded()
    disk.nodes.delete(`${fromProject}/${SESSION}.jsonl`)
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "not-found" })
  })

  test("a transcript of the same id under some other cwd's project is not this conversation", async () => {
    const disk = seeded()
    disk.nodes.delete(`${fromProject}/${SESSION}.jsonl`)
    disk.nodes.set(`${ROOT}/${FROM}/projects/-tmp`, { kind: "dir" })
    disk.nodes.set(`${ROOT}/${FROM}/projects/-tmp/${SESSION}.jsonl`, {
      kind: "file",
      text: "{}",
    })
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "not-found" })
  })

  test("a transcript over the size cap is left where it is", async () => {
    const disk = seeded()
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 10, fs: disk.fs })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "too-large" })
    expect(disk.reads).toHaveLength(0)
  })

  test("a target account with no config directory is not created by a carry", async () => {
    const disk = seeded()
    disk.nodes.delete(`${ROOT}/${TO}`)
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    expect(await carrier.carry(input)).toEqual({ carried: false, reason: "target-missing" })
    expect(disk.nodes.has(`${ROOT}/${TO}/projects`)).toBe(false)
  })

  test("ids that are not uuids, or one account carried to itself, are refused before any read", async () => {
    const disk = seeded()
    const carrier = createSessionCarrier({ root: ROOT, maxBytes: 1_000_000, fs: disk.fs })

    for (const bad of [
      { ...input, sdkSessionId: "../../.credentials" },
      { ...input, fromAccountId: ".." },
      { ...input, toAccountId: "acct-2" },
      { ...input, toAccountId: FROM },
    ]) {
      expect(await carrier.carry(bad)).toEqual({ carried: false, reason: "invalid-input" })
    }
    expect(disk.reads).toHaveLength(0)
  })
})
