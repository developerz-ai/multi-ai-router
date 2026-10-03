import { afterEach, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type AccountOwnershipConfig,
  createAccountCliOwnership,
} from "../../../src/providers/claude-sdk/account-ownership"
import { createOwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "router-cli-owner-"))
  roots.push(root)
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
  "ready guardian has no CLI child until activation and proves final owner retirement",
  async () => {
    const { config, configDir, id } = await fixture()
    const scope = createOwnerLaunch(config, id)
    const child = scope.spawn({
      command: "/bin/echo",
      args: ["activated"],
      cwd: configDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: new AbortController().signal,
    })
    let output = ""
    child.stdout.on("data", (data) => {
      output += data.toString()
    })
    try {
      await scope.ready
      expect(output).toBe("")
      expect((await readdir(join(config.root, ".ownership", id, "owners"))).length).toBe(1)
      await scope.prepare()
      scope.activate()
      await scope.exited
      expect(output).toBe("activated\n")
      expect(await readdir(join(config.root, ".ownership", id, "owners"))).toEqual([])
    } finally {
      scope.cancel()
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "revoke and stop preserve metadata ownership until paused filesystem callback settles",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    const started = deferred()
    const finish = deferred()
    const task = owners.withMetadataOwner(id, async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise
    await owners.revokeDeletedAccount({ id, configDir })
    let stopped = false
    const stopping = owners.stop().then(() => {
      stopped = true
    })
    try {
      expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("deferred")
      expect(stopped).toBe(false)
      expect((await readdir(join(config.root, ".ownership", id, "owners"))).length).toBe(1)
    } finally {
      finish.resolve()
      await task
      await stopping
    }
    expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("removed")
  },
)

test.skipIf(process.platform !== "linux")(
  "authority mismatch refuses launch and directory removal",
  async () => {
    const { config, configDir, id } = await fixture()
    const scope = createOwnerLaunch(config, id)
    expect(() =>
      scope.spawn({
        command: "/bin/true",
        args: [],
        cwd: join(config.root, randomUUID()),
        env: { CLAUDE_CONFIG_DIR: configDir },
        signal: new AbortController().signal,
      }),
    ).toThrow("authority mismatch")
    scope.cancel()
    await scope.exited
    const owners = createAccountCliOwnership(config)
    await expect(owners.cleanupDeletedAccount({ id, configDir: "/foreign" })).rejects.toThrow(
      "authority mismatch",
    )
  },
)

test.skipIf(process.platform !== "linux")(
  "permanent tombstone forbids reprovision after physical cleanup",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    await owners.provisionAccount({ id, configDir })
    await owners.revokeDeletedAccount({ id, configDir })
    expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("removed")
    await expect(owners.provisionAccount({ id, configDir })).rejects.toThrow("retired")
    expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("removed")
  },
)

test.skipIf(process.platform !== "linux")(
  "bounded shutdown reports unknown while outstanding metadata owner remains protected",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership({ ...config, shutdownDrainMs: 20 })
    const started = deferred()
    const finish = deferred()
    const task = owners.withMetadataOwner(id, async () => {
      started.resolve()
      await finish.promise
    })
    await started.promise
    try {
      await expect(owners.stop()).rejects.toThrow("shutdown timed out")
      await owners.revokeDeletedAccount({ id, configDir })
      expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("deferred")
      expect((await readdir(join(config.root, ".ownership", id, "owners"))).length).toBe(1)
    } finally {
      finish.resolve()
      await task
    }
    expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("removed")
  },
)

test.skipIf(process.platform !== "linux")(
  "concurrent cleanup cannot permit reprovision or replace the stable lock inode",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    await owners.provisionAccount({ id, configDir })
    await owners.revokeDeletedAccount({ id, configDir })
    const lock = join(config.root, ".ownership", id, "lock")
    const before = await stat(lock)
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, async () => {
        await owners.cleanupDeletedAccount({ id, configDir })
        return owners.provisionAccount({ id, configDir })
      }),
    )
    expect(results.every((result) => result.status === "rejected")).toBe(true)
    expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("removed")
    expect((await stat(lock)).ino).toBe(before.ino)
  },
)

test.skipIf(process.platform !== "linux")(
  "metadata acquisition refusal is skippable while filesystem callback failures remain failures",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    const failure = new Error("filesystem read failed")
    await expect(
      owners.withMetadataOwner(id, async () => {
        throw failure
      }),
    ).rejects.toBe(failure)
    await owners.revokeDeletedAccount({ id, configDir })
    let callbacks = 0
    const rejected = owners.withMetadataOwner(id, async () => {
      callbacks++
    })
    await expect(rejected).rejects.toMatchObject({ name: "UpstreamAdmissionRefused" })
    expect(callbacks).toBe(0)
  },
)

test.skipIf(process.platform !== "linux")(
  "admitted metadata guardian crash is a typed refusal and never proves cleanup safe",
  async () => {
    const { config, configDir, id } = await fixture()
    const owners = createAccountCliOwnership(config)
    const started = deferred()
    const finish = deferred()
    const task = owners.withMetadataOwner(id, async () => {
      started.resolve()
      await finish.promise
      return "filesystem callback settled"
    })
    // Observe rejection immediately so a crash cannot cause an unhandled rejection.
    const result = task.then(
      (value) => ({ value, error: undefined }),
      (error: unknown) => ({ value: undefined, error }),
    )
    await started.promise
    let guardian: number | undefined
    for (const entry of await readdir("/proc")) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const argv = (await readFile(`/proc/${entry}/cmdline`, "utf8")).split("\0")
        if (
          argv[0] !== config.helperPath ||
          argv[1] !== "hold" ||
          argv[2] !== config.root ||
          argv[3] !== id
        )
          continue
        const status = await readFile(`/proc/${entry}/status`, "utf8")
        if (new RegExp(`^PPid:\\s+${process.pid}$`, "m").test(status)) guardian = Number(entry)
      } catch {
        // Unrelated processes can disappear while enumerating /proc.
      }
    }
    try {
      if (guardian === undefined) throw new Error("metadata guardian was not found")
      process.kill(guardian, "SIGKILL")
      finish.resolve()
      const settled = await result
      expect(settled.value).toBeUndefined()
      expect(settled.error).toMatchObject({
        name: "UpstreamAdmissionRefused",
        message: "credential metadata owner exit uncertain",
      })
      await owners.revokeDeletedAccount({ id, configDir })
      expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("deferred")
      expect((await readdir(join(config.root, ".ownership", id, "owners"))).length).toBe(1)
    } finally {
      finish.resolve()
      await result
    }
  },
)
