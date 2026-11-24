import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createAccountCliOwnership } from "../../../src/providers/claude-sdk/account-ownership"
import { neverRegistered } from "../../../src/providers/claude-sdk/owner-helper"
import type { ReplicaGenerationHandle } from "../../../src/providers/claude-sdk/replica-lease"

/**
 * An exit that provably owned nothing is not an uncertain one. Both shapes here used to add the
 * Account to the permanent retirement list, refusing it until the process restarted: a launch over
 * the owner ceiling, and a client that hung up while the guardian was still starting.
 */

async function account(maximumOwners = 64, termGraceMs = 1_000) {
  const root = await mkdtemp(join(tmpdir(), "owner-retirement-"))
  const id = randomUUID()
  const generation: ReplicaGenerationHandle = {
    accountId: id,
    owner: randomUUID(),
    generation: 2n,
    signal: new AbortController().signal,
    valid: () => true,
    assert() {},
    remainingMs: () => 60_000,
  }
  const owners = createAccountCliOwnership({
    root,
    helperPath: resolve("native/config-owner"),
    maximumOwners,
    termGraceMs,
    pollMs: 5,
    maximumChildren: 16,
    admissionTimeoutMs: 5_000,
    cleanupMaximumEntries: 100,
    cleanupMaximumDepth: 8,
    operationTimeoutMs: 5_000,
    shutdownDrainMs: 5_000,
    generation: () => generation,
  })
  const configDir = join(root, id)
  await owners.provisionAccount({ id, configDir })
  const launch = (script: string, signal = new AbortController().signal) => {
    const scope = owners.ownerLaunch(id)
    void scope.ready.catch(() => {})
    scope.spawn({
      command: "/bin/sh",
      args: ["-c", script],
      cwd: configDir,
      env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir },
      signal,
    })
    return scope
  }
  const start = async (script: string) => {
    const scope = launch(script)
    await scope.ready
    await scope.prepare()
    scope.activate()
    await scope.started
    return scope
  }
  const markers = () => readdir(join(root, ".ownership", id, "owners"))
  return { root, id, owners, launch, start, markers, close: () => rm(root, { recursive: true }) }
}

describe("neverRegistered", () => {
  test("only an exit that cannot have left a marker is certain without Q", () => {
    expect(neverRegistered(73, null)).toBe(true)
    expect(neverRegistered(75, null)).toBe(true)
    expect(neverRegistered(null, "SIGTERM")).toBe(true)
    expect(neverRegistered(null, "SIGUSR2")).toBe(true)
    for (const code of [0, 1, 64, 70, 127]) expect(neverRegistered(code, null)).toBe(false)
    for (const signal of ["SIGKILL", "SIGSEGV", "SIGPIPE"] as const)
      expect(neverRegistered(null, signal)).toBe(false)
    expect(neverRegistered(null, null)).toBe(false)
  })
})

describe.skipIf(process.platform !== "linux")("native guardian exits", () => {
  test("a launch over the owner ceiling is refused, and the Account serves again after it", async () => {
    const a = await account(1)
    try {
      const first = await a.start("sleep 30")
      const second = a.launch("true")
      await expect(second.ready).rejects.toThrow()
      await second.exited
      first.cancel()
      await first.exited
      const third = await a.start("exit 0")
      await third.exited
      expect(await a.markers()).toEqual([])
    } finally {
      await a.close()
    }
  })

  test("hanging up while the guardian starts leaves the Account usable", async () => {
    const a = await account()
    try {
      // Every delay a launch passes through: before its signal handlers, before and after R.
      for (const delayMs of [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 3, 5]) {
        const client = new AbortController()
        const scope = a.launch("sleep 30", client.signal)
        if (delayMs > 0) await Bun.sleep(delayMs)
        client.abort()
        await scope.exited
      }
      const after = await a.start("exit 0")
      await after.exited
      expect(await a.markers()).toEqual([])
    } finally {
      await a.close()
    }
  })

  test("a killed guardian still retires uncertain and refuses the Account", async () => {
    const a = await account()
    try {
      const scope = a.owners.ownerLaunch(a.id)
      const child = scope.spawn({
        command: "/bin/sh",
        args: ["-c", "sleep 30"],
        cwd: join(a.root, a.id),
        env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(a.root, a.id) },
        signal: new AbortController().signal,
      })
      await scope.ready
      const pid: unknown = Reflect.get(child, "pid")
      if (typeof pid !== "number") throw new Error("guardian has no pid")
      process.kill(pid, "SIGKILL")
      await expect(scope.exited).rejects.toThrow("exit is uncertain")
      expect(() => a.owners.ownerLaunch(a.id)).toThrow("retirement uncertain")
      expect(await a.markers()).toHaveLength(1)
    } finally {
      await a.close()
    }
  })

  test("a fenced cancel grants the configured TERM grace before KILL", async () => {
    const a = await account(64, 2_000)
    try {
      const up = join(a.root, "up")
      const saved = join(a.root, "saved")
      const scope = await a.start(
        `trap 'sleep 0.1; echo saved > ${saved}; exit 0' TERM; echo up > ${up}; while :; do sleep 0.02; done`,
      )
      while (!(await Bun.file(up).exists())) await Bun.sleep(5)
      scope.cancel()
      await scope.exited
      expect(await Bun.file(saved).exists()).toBe(true)
    } finally {
      await a.close()
    }
  })

  test("a child that ignores TERM is killed at the end of the grace", async () => {
    const a = await account(64, 100)
    try {
      const up = join(a.root, "up")
      const scope = await a.start(`trap '' TERM; echo up > ${up}; while :; do sleep 0.02; done`)
      while (!(await Bun.file(up).exists())) await Bun.sleep(5)
      const started = performance.now()
      scope.cancel()
      await scope.exited
      const elapsed = performance.now() - started
      expect(elapsed).toBeGreaterThan(80)
      expect(elapsed).toBeLessThan(2_000)
    } finally {
      await a.close()
    }
  })
})

test("deleting an Account with no directory asks for no replica lease", async () => {
  const owners = createAccountCliOwnership({
    root: "/nonexistent-claude-root",
    helperPath: "/nonexistent-helper",
    maximumOwners: 1,
    termGraceMs: 1,
    pollMs: 1,
    maximumChildren: 1,
    admissionTimeoutMs: 1,
    cleanupMaximumEntries: 1,
    cleanupMaximumDepth: 1,
    operationTimeoutMs: 1,
    shutdownDrainMs: 1,
    generation: () => {
      throw new Error("account replica ownership unavailable")
    },
  })
  const target = { id: randomUUID(), configDir: null }
  await owners.revokeDeletedAccount(target)
  expect(await owners.cleanupDeletedAccount(target)).toBe("not_applicable")
  // A directory still needs the lease.
  const held = { id: target.id, configDir: join("/nonexistent-claude-root", target.id) }
  await expect(owners.revokeDeletedAccount(held)).rejects.toThrow("ownership unavailable")
  await expect(owners.cleanupDeletedAccount(held)).rejects.toThrow("ownership unavailable")
})
