import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  type AccountOwnershipConfig,
  createAccountCliOwnership,
} from "../../../src/providers/claude-sdk/account-ownership"
import { createOwnerLaunch } from "../../../src/providers/claude-sdk/owner-launch"

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "router-owner-tree-"))
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

test.skipIf(process.platform !== "linux")(
  "guardian retains adopted detached descendant then TERM/KILL reaps before retirement",
  async () => {
    const { root, id, configDir, config } = await fixture()
    const scope = createOwnerLaunch(config, id)
    const descendant = join(root, "descendant.js")
    const principal = join(root, "principal.js")
    await writeFile(
      descendant,
      `const fs=require('node:fs');process.on('SIGTERM',()=>{});fs.writeFileSync(${JSON.stringify(join(root, "ready"))},'ready');setInterval(()=>{},1000);`,
    )
    await writeFile(
      principal,
      `require('node:child_process').spawn(process.execPath,[${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'}).unref();`,
    )
    scope.spawn({
      command: process.execPath,
      args: [principal],
      cwd: configDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: new AbortController().signal,
    })
    try {
      await scope.ready
      await scope.prepare()
      scope.activate()
      const until = Date.now() + 2000
      for (;;) {
        try {
          await stat(join(root, "ready"))
          break
        } catch {
          if (Date.now() > until) throw new Error("stub descendant did not start")
          await Bun.sleep(5)
        }
      }
      expect((await readdir(join(root, ".ownership", id, "owners"))).length).toBe(1)
      scope.cancel()
      await scope.exited
      expect(await readdir(join(root, ".ownership", id, "owners"))).toEqual([])
    } finally {
      scope.cancel()
      await rm(root, { recursive: true, force: true })
    }
  },
)

test.skipIf(process.platform !== "linux")(
  "external guardian SIGKILL leaves unknown owner marker and cleanup defers",
  async () => {
    const { root, id, configDir, config } = await fixture()
    const scope = createOwnerLaunch(config, id)
    const child = scope.spawn({
      command: "/bin/cat",
      args: [],
      cwd: configDir,
      env: { CLAUDE_CONFIG_DIR: configDir },
      signal: new AbortController().signal,
    }) as ChildProcess
    try {
      await scope.ready
      await scope.prepare()
      scope.activate()
      if (child.pid === undefined) throw new Error("fixture guardian had no PID")
      process.kill(child.pid, "SIGKILL")
      child.stdin?.end()
      await expect(scope.exited).rejects.toThrow("uncertain")
      const owners = createAccountCliOwnership(config)
      await owners.revokeDeletedAccount({ id, configDir })
      expect(await owners.cleanupDeletedAccount({ id, configDir })).toBe("deferred")
      expect((await readdir(join(root, ".ownership", id, "owners"))).length).toBe(1)
    } finally {
      scope.cancel()
      await rm(root, { recursive: true, force: true })
    }
  },
)
