import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type AccountOwnershipConfig,
  createAccountCliOwnership,
} from "../../../src/providers/claude-sdk/account-ownership"
import { ownedQuery } from "../../../src/providers/claude-sdk/owned-query"
import { createOwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "router-owner-activate-"))
  const id = randomUUID()
  const configDir = join(root, id)
  await mkdir(configDir, { mode: 0o700 })
  const config: AccountOwnershipConfig = {
    root,
    helperPath: resolve("native/config-owner"),
    maximumOwners: 2,
    termGraceMs: 30,
    pollMs: 5,
    maximumChildren: 10,
    admissionTimeoutMs: 1000,
    cleanupMaximumEntries: 100,
    cleanupMaximumDepth: 8,
    operationTimeoutMs: 1000,
    shutdownDrainMs: 1000,
  }
  return { root, id, configDir, config }
}
function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test.skipIf(process.platform !== "linux")(
  "foreign deletion while R waits refuses activation before consuming start authority",
  async () => {
    const { root, id, configDir, config } = await fixture()
    const first = createAccountCliOwnership(config)
    const second = createAccountCliOwnership(config)
    const paused = deferred()
    const resume = deferred()
    let guards = 0
    let output = ""
    const pending = ownedQuery({
      accountId: id,
      options: {},
      signal: new AbortController().signal,
      ownerLaunch: (accountId) => {
        const owner = first.ownerLaunch(accountId)
        return {
          ...owner,
          async prepare() {
            paused.resolve()
            await resume.promise
            await owner.prepare()
          },
        }
      },
      beforeUpstreamStart: () => {
        guards++
      },
      run(options) {
        if (!options.spawnClaudeCodeProcess) throw new Error("fixture owner hook missing")
        const child = options.spawnClaudeCodeProcess({
          command: "/bin/echo",
          args: ["must-not-start"],
          cwd: configDir,
          env: { CLAUDE_CONFIG_DIR: configDir },
          signal: new AbortController().signal,
        })
        child.stdout.on("data", (value) => {
          output += value.toString()
        })
        return {}
      },
    })
    try {
      await paused.promise
      await second.revokeDeletedAccount({ id, configDir })
      resume.resolve()
      await expect(pending).rejects.toThrow("preparation refused")
      expect(guards).toBe(0)
      expect(output).toBe("")
      await first.stop()
      expect(await second.cleanupDeletedAccount({ id, configDir })).toBe("removed")
    } finally {
      resume.resolve()
      await first.stop().catch(() => {})
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "native metadata hold owns lifetime independently of the supplied child command",
  async () => {
    const { root, id, configDir, config } = await fixture()
    const owner = createOwnerLaunch(config, id, true)
    owner.spawn({
      command: "/bin/false",
      args: [],
      cwd: configDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: new AbortController().signal,
    })
    try {
      await owner.ready
      await owner.prepare()
      owner.activate()
      await owner.started
      expect((await readdir(join(root, ".ownership", id, "owners"))).length).toBe(1)
      let ended = false
      void owner.exited.then(() => {
        ended = true
      })
      await Promise.resolve()
      expect(ended).toBe(false)
      owner.release()
      await owner.exited
      expect(await readdir(join(root, ".ownership", id, "owners"))).toEqual([])
    } finally {
      owner.release()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "foreign tombstone before metadata activation never admits a filesystem callback",
  async () => {
    const { root, id, configDir, config } = await fixture()
    const owner = createOwnerLaunch(config, id, true)
    const foreign = createAccountCliOwnership(config)
    owner.spawn({
      command: "/bin/false",
      args: [],
      cwd: configDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: new AbortController().signal,
    })
    let callbacks = 0
    try {
      await owner.ready
      await foreign.revokeDeletedAccount({ id, configDir })
      try {
        await owner.prepare()
        owner.activate()
        await owner.started
        callbacks++
      } catch {
        /* Refused before router I/O. */
      }
      await owner.exited
      expect(callbacks).toBe(0)
      expect(await foreign.cleanupDeletedAccount({ id, configDir })).toBe("removed")
    } finally {
      owner.cancel()
      await rm(root, { recursive: true, force: true })
    }
  },
)
