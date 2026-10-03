import { expect, test } from "bun:test"
import { ownedQuery } from "../../../src/providers/claude-sdk/owned-query"
import type { OwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"

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
