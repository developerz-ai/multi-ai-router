import { expect, test } from "bun:test"
import { stat } from "node:fs/promises"
import { ownedQuery } from "../../../src/providers/claude-sdk/owned-query"
import type { OwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"
import { nativeGuardian } from "./native-guardian-fixture"

function deferred() {
  let resolve = () => {}
  let reject: (error: Error) => void = () => {}
  const promise = new Promise<void>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
function fixture() {
  const ready = deferred()
  const background = deferred()
  const events: string[] = []
  const owner: OwnerLaunch = {
    ready: ready.promise,
    exited: Promise.resolve(),
    started: Promise.resolve(),
    async prepare() {
      events.push("prepare")
    },
    release() {},
    spawn() {
      throw new Error("fixture never launches a process")
    },
    assertReady() {},
    activate() {
      events.push("activate")
    },
    cancel() {
      events.push("cancel")
    },
  }
  return { ready, background, events, owner }
}

test("guardian readiness and final background verdict precede single start authority", async () => {
  const { ready, background, events, owner } = fixture()
  let queries = 0
  const pending = ownedQuery({
    accountId: "fixture",
    options: {},
    signal: new AbortController().signal,
    ownerLaunch: () => owner,
    beforeBackgroundUpstreamStart: async () => {
      events.push("background")
      await background.promise
    },
    beforeUpstreamStart: () => {
      events.push("guard")
    },
    run: (options) => {
      queries++
      expect(options.spawnClaudeCodeProcess).toBe(owner.spawn)
      return { identity: "same-query" }
    },
  })
  expect(events).toEqual([])
  ready.resolve()
  for (let tick = 0; tick < 20 && !events.includes("background"); tick++) await Promise.resolve()
  expect(events).toEqual(["prepare", "background"])
  background.resolve()
  expect(await pending).toEqual({ identity: "same-query" })
  expect(events).toEqual(["prepare", "background", "guard", "activate"])
  expect(queries).toBe(1)
})

test("guardian setup refusal never spends start authority", async () => {
  const { ready, events, owner } = fixture()
  const pending = ownedQuery({
    accountId: "fixture",
    options: {},
    signal: new AbortController().signal,
    ownerLaunch: () => owner,
    beforeUpstreamStart: () => {
      events.push("guard")
    },
    run: () => ({}),
  })
  ready.reject(new Error("owner unavailable"))
  await expect(pending).rejects.toThrow("owner unavailable")
  expect(events).toEqual(["cancel"])
})

test("background refusal after owner readiness cancels idle guardian without activation", async () => {
  const { ready, events, owner } = fixture()
  ready.resolve()
  const pending = ownedQuery({
    accountId: "fixture",
    options: {},
    signal: new AbortController().signal,
    ownerLaunch: () => owner,
    beforeBackgroundUpstreamStart: async () => {
      throw new Error("stale account")
    },
    beforeUpstreamStart: () => {
      events.push("guard")
    },
    run: () => ({}),
  })
  await expect(pending).rejects.toThrow("stale account")
  expect(events).toEqual(["prepare", "cancel"])
})

test("durable background eligibility is reread after a delayed guardian prepare wait", async () => {
  const { ready, events, owner } = fixture()
  ready.resolve()
  const prepare = deferred()
  let eligible = true
  const pending = ownedQuery({
    accountId: "fixture",
    options: {},
    signal: new AbortController().signal,
    ownerLaunch: () => ({
      ...owner,
      async prepare() {
        events.push("prepare")
        await prepare.promise
      },
    }),
    beforeBackgroundUpstreamStart: async () => {
      events.push("background")
      if (!eligible) throw new Error("account changed during ownership wait")
    },
    beforeUpstreamStart: () => {
      events.push("guard")
    },
    run: () => ({}),
  })
  for (let tick = 0; tick < 20 && !events.includes("prepare"); tick++) await Promise.resolve()
  expect(events).toEqual(["prepare"])
  eligible = false
  prepare.resolve()
  await expect(pending).rejects.toThrow("account changed during ownership wait")
  expect(events).toEqual(["prepare", "background", "cancel"])
})

test.skipIf(process.platform !== "linux")(
  "native stale generation refuses without creating an owner marker",
  async () => {
    const f = await nativeGuardian("run-fenced", 2000, "3")
    try {
      expect(await f.exited).toBe(75)
      expect(await f.markers()).toEqual([])
    } finally {
      await f.dispose()
    }
  },
)

for (const frame of [
  "partial",
  "malformed",
  "oversized",
  "foreign",
  "stale",
  "unbounded",
] as const) {
  test.skipIf(process.platform !== "linux")(
    `native ${frame} renewal cannot extend preparation authority`,
    async () => {
      const f = await nativeGuardian()
      try {
        await f.registered()
        const next = f.deadline + 30_000n
        const frames = {
          partial: `U ${f.owner} 2 ${next}`,
          malformed: `U ${f.owner} 2 nope\n`,
          oversized: `U${"x".repeat(256)}\n`,
          foreign: `U ${crypto.randomUUID()} 2 ${next}\n`,
          stale: `U ${f.owner} 1 ${next}\n`,
          unbounded: `U ${f.owner} 2 ${f.deadline + 600_000n}\n`,
        }
        f.control.write(frames[frame])
        expect(await f.exited).toBe(75)
        expect(await f.markers()).toEqual([])
      } finally {
        await f.dispose()
      }
    },
  )
}

for (const stage of ["registered", "prepared", "executing", "eof"] as const) {
  test.skipIf(process.platform !== "linux")(
    `native lease termination during ${stage} retires only after descendants exit`,
    async () => {
      const f = await nativeGuardian("run-fenced", stage === "eof" ? 30_000 : 800)
      try {
        await f.registered()
        if (stage !== "registered") await f.prepare()
        let descendant: number | undefined
        if (stage === "executing" || stage === "eof") {
          await f.activate()
          descendant = await f.descendant()
          await stat(`/proc/${descendant}`)
        }
        if (stage === "eof") f.control.end()
        expect(await f.exited).not.toBe(0)
        expect(await f.markers()).toEqual([])
        if (descendant !== undefined) await expect(stat(`/proc/${descendant}`)).rejects.toThrow()
      } finally {
        await f.dispose()
      }
    },
  )
}

for (const reason of ["expiry", "eof"] as const) {
  test.skipIf(process.platform !== "linux")(
    `native metadata ${reason} retains uncertain ownership marker`,
    async () => {
      const f = await nativeGuardian("hold-fenced", reason === "eof" ? 30_000 : 800)
      try {
        await f.registered()
        await f.prepare()
        await f.activate()
        if (reason === "eof") f.control.end()
        expect(await f.exited).toBe(70)
        expect(await f.markers()).toEqual([f.marker])
      } finally {
        await f.dispose()
      }
    },
  )
}
