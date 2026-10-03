import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createSdkConcurrency, createSdkInvoker } from "../../../src/providers"
import { ownedQuery } from "../../../src/providers/claude-sdk/owned-query"
import { createOwnerLaunch, type OwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"
import { sdkQueryStream, sdkTurn } from "./fixtures"

const invocation = {
  accountId: "offline",
  configDir: "/offline",
  model: "offline-model",
  body: new TextEncoder().encode(
    '{"model":"offline-model","messages":[{"role":"user","content":"ping"}]}',
  ),
  signal: new AbortController().signal,
  session: { kind: "fresh", reason: "no-session" } as const,
}
for (const mode of [
  "setup",
  "ready",
  "prepare",
  "activation",
  "acknowledgement",
  "constructor",
] as const) {
  test(`invoker ${mode} failure has no actual-start callback and releases its slot`, async () => {
    const failure = new Error(`offline ${mode} failure`)
    const rejected = Promise.reject(failure)
    void rejected.catch(() => {})
    let callbacks = 0,
      canceled = 0,
      pulls = 0
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const owner: OwnerLaunch = {
      ready: mode === "ready" ? rejected : Promise.resolve(),
      started: mode === "acknowledgement" ? rejected : Promise.resolve(),
      exited: Promise.resolve(),
      prepare: async () => {
        if (mode === "prepare") throw failure
      },
      assertReady: () => {},
      activate: () => {
        if (mode === "activation") throw failure
      },
      cancel: () => {
        canceled++
      },
      release: () => {},
      spawn: () => {
        throw new Error("must not launch a real CLI")
      },
    }
    const invoke = createSdkInvoker({
      concurrency,
      resolveCli: () => ({
        ok: true,
        source: "env_override",
        path: "/offline/claude",
        bytes: 1000,
      }),
      ownerLaunch: () => {
        if (mode === "setup") throw failure
        return owner
      },
      runQuery: () => {
        if (mode === "constructor") throw failure
        return {
          [Symbol.asyncIterator]() {
            return {
              next: async () => {
                pulls++
                throw new Error("must not pull before acknowledgement")
              },
            }
          },
        }
      },
    })
    await expect(
      invoke({
        ...invocation,
        onUpstreamStarted: () => {
          callbacks++
        },
      }),
    ).rejects.toBe(failure)
    expect(callbacks).toBe(0)
    expect(pulls).toBe(0)
    expect(concurrency.inFlight).toBe(0)
    if (mode !== "setup") expect(canceled).toBe(1)
  })
}
test("start acknowledgement follows final guards and activation, without pulling or constructing twice", async () => {
  const ack = Promise.withResolvers<void>()
  const events: string[] = []
  const query = { identity: "query" }
  const owner: OwnerLaunch = {
    ready: Promise.resolve(),
    started: ack.promise,
    exited: Promise.resolve(),
    prepare: async () => {
      events.push("prepare")
    },
    assertReady: () => {
      events.push("assert")
    },
    activate: () => {
      events.push("activate")
    },
    cancel: () => {},
    release: () => {},
    spawn: () => {
      throw new Error("no process in fixture")
    },
  }
  let constructions = 0
  const pending = ownedQuery({
    accountId: "offline",
    options: {},
    signal: invocation.signal,
    ownerLaunch: () => owner,
    beforeBackgroundUpstreamStart: async () => {
      events.push("background")
    },
    beforeUpstreamStart: () => {
      events.push("guard")
    },
    onUpstreamStarted: () => {
      events.push("started")
    },
    run: () => {
      constructions++
      return query
    },
  })
  for (let i = 0; i < 20 && !events.includes("activate"); i++) await Promise.resolve()
  expect(events).toEqual(["prepare", "background", "assert", "guard", "activate"])
  ack.resolve()
  expect(await pending).toBe(query)
  expect(events).toEqual(["prepare", "background", "assert", "guard", "activate", "started"])
  expect(constructions).toBe(1)
})
test("fixture without owner reports a start only after successful query construction", async () => {
  let callbacks = 0
  await expect(
    ownedQuery({
      accountId: "offline",
      options: {},
      signal: invocation.signal,
      onUpstreamStarted: () => {
        callbacks++
      },
      run: () => {
        throw new Error("construction failed")
      },
    }),
  ).rejects.toThrow("construction failed")
  expect(callbacks).toBe(0)
  const query = {}
  expect(
    await ownedQuery({
      accountId: "offline",
      options: {},
      signal: invocation.signal,
      onUpstreamStarted: () => {
        callbacks++
      },
      run: () => query,
    }),
  ).toBe(query)
  expect(callbacks).toBe(1)
})
test.skipIf(process.platform !== "linux")(
  "real guardian B acknowledgement reports one local synthetic child start",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "router-start-evidence-"))
    const accountId = randomUUID(),
      configDir = join(root, accountId)
    await mkdir(configDir, { mode: 0o700 })
    const owner = createOwnerLaunch(
      {
        root,
        helperPath: resolve("native/config-owner"),
        maximumOwners: 2,
        termGraceMs: 30,
        pollMs: 5,
        maximumChildren: 10,
        admissionTimeoutMs: 1000,
      },
      accountId,
    )
    let callbacks = 0
    const concurrency = createSdkConcurrency({ global: 1, perAccount: 1 })
    const invoke = createSdkInvoker({
      concurrency,
      resolveCli: () => ({ ok: true, source: "env_override", path: "/bin/echo", bytes: 1000 }),
      ownerLaunch: () => owner,
      runQuery: ({ options }) => {
        if (!options.spawnClaudeCodeProcess) throw new Error("owner hook not wired")
        options.spawnClaudeCodeProcess({
          command: "/bin/echo",
          args: ["synthetic child only"],
          cwd: configDir,
          env: { CLAUDE_CONFIG_DIR: configDir },
          signal: invocation.signal,
        })
        return sdkQueryStream({
          turns: [
            sdkTurn({
              blocks: [
                [
                  { type: "text", text: "" },
                  { type: "text_delta", text: "pong" },
                ],
              ],
            }),
          ],
        })
      },
    })
    try {
      const response = await invoke({
        ...invocation,
        accountId,
        configDir,
        onUpstreamStarted: () => {
          callbacks++
        },
      })
      await response.text()
      await owner.exited
      expect(callbacks).toBe(1)
      expect(concurrency.inFlight).toBe(0)
    } finally {
      owner.cancel()
      await rm(root, { recursive: true, force: true })
    }
  },
)
