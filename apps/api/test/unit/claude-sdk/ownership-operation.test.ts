import { expect, test } from "bun:test"
import { ChildProcess } from "node:child_process"
import { createAccountCliOwnership } from "../../../src/providers/claude-sdk/account-ownership"
import { ownerMonotonicMilliseconds } from "../../../src/providers/claude-sdk/owner-clock"
import { ownershipOperation } from "../../../src/providers/claude-sdk/ownership-operation"

class DeferredExit extends ChildProcess {
  override readonly pid = 42
  readonly signals: (string | number | undefined)[] = []
  override kill(signal?: string | number) {
    this.signals.push(signal)
    return true
  }
}
test.skipIf(process.platform !== "linux")(
  "operation errors after spawn do not prove child retirement",
  async () => {
    const child = new DeferredExit()
    let settled = false
    const pending = ownershipOperation(
      { root: "/fixture", helperPath: "/fixture-helper", operationTimeoutMs: 1000 },
      "cleanup",
      "fixture",
      [],
      { spawn: () => child, schedule: () => () => {} },
    ).then((code) => {
      settled = true
      return code
    })
    child.emit("error", new Error("kill failed"))
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.signals).toEqual(["SIGKILL"])
    child.emit("exit", null, "SIGKILL")
    expect(await pending).toBe(70)
  },
)
test.skipIf(process.platform !== "linux")(
  "public cleanup deadline requests termination but waits for confirmed child exit",
  async () => {
    const child = new DeferredExit()
    let deadline = () => {}
    let canceled = false
    const owners = createAccountCliOwnership(
      {
        root: "/tmp/ownership-operation-fixture",
        helperPath: "/unused-helper",
        maximumOwners: 2,
        termGraceMs: 30,
        pollMs: 5,
        maximumChildren: 10,
        admissionTimeoutMs: 1000,
        cleanupMaximumEntries: 100,
        cleanupMaximumDepth: 8,
        operationTimeoutMs: 25,
        shutdownDrainMs: 1000,
      },
      {
        spawn: () => child,
        schedule(callback, duration) {
          expect(duration).toBe(25)
          deadline = callback
          return () => {
            canceled = true
          }
        },
      },
    )
    const cleanup = owners.cleanupDeletedAccount({
      id: "account",
      configDir: "/tmp/ownership-operation-fixture/account",
    })
    let settled = false
    void cleanup.then(() => {
      settled = true
    })
    deadline()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(child.signals).toEqual(["SIGKILL"])
    expect(canceled).toBe(false)
    child.emit("exit", 0, null)
    expect(await cleanup).toBe("deferred")
    expect(canceled).toBe(true)
    child.emit("error", new Error("delayed termination"))
    expect(await cleanup).toBe("deferred")
    expect(owners.isRevoked?.("account")).toBe(true)
    expect(() => owners.ownerLaunch("account")).toThrow("retirement uncertain")
    await expect(
      owners.cleanupDeletedAccount({
        id: "account",
        configDir: "/tmp/ownership-operation-fixture/account",
      }),
    ).rejects.toThrow("retirement uncertain")
  },
)

for (const alreadyAborted of [false, true]) {
  test.skipIf(process.platform !== "linux")(
    `fenced operation bounds native deadline and waits for abort exit, preaborted=${alreadyAborted}`,
    async () => {
      const child = new DeferredExit()
      const abort = new AbortController()
      if (alreadyAborted) abort.abort()
      const owner = crypto.randomUUID()
      const accountId = crypto.randomUUID()
      let asserted = false
      let canceled = false
      let settled = false
      const before = ownerMonotonicMilliseconds()
      const pending = ownershipOperation(
        {
          helperPath: "/unused-helper",
          root: "/fixture",
          operationTimeoutMs: 1000,
          generation: () => ({
            owner,
            accountId,
            generation: 9007199254740993n,
            signal: abort.signal,
            assert() {
              asserted = true
            },
            valid: () => true,
            remainingMs: () => 40.9,
          }),
        },
        "cleanup",
        accountId,
        ["100", "8"],
        {
          spawn(command, args) {
            expect(asserted).toBe(true)
            expect(command).toBe("/unused-helper")
            expect(args.slice(0, 5)).toEqual([
              "cleanup-fenced",
              "/fixture",
              accountId,
              owner,
              "9007199254740993",
            ])
            const deadline = BigInt(args[5] ?? "0")
            expect(deadline >= before + 40n).toBe(true)
            expect(deadline <= ownerMonotonicMilliseconds() + 40n).toBe(true)
            expect(args.slice(6)).toEqual(["100", "8"])
            return child
          },
          schedule(_callback, duration) {
            expect(duration).toBe(40)
            return () => {
              canceled = true
            }
          },
        },
      ).then((code) => {
        settled = true
        return code
      })
      if (!alreadyAborted) abort.abort()
      await Promise.resolve()
      expect(child.signals).toEqual(["SIGKILL"])
      expect(settled).toBe(false)
      expect(canceled).toBe(false)
      child.emit("exit", null, "SIGKILL")
      expect(await pending).toBe(70)
      expect(canceled).toBe(true)
    },
  )
}

test.skipIf(process.platform !== "linux")("expired generation never launches an operation", () => {
  expect(() =>
    ownershipOperation(
      {
        root: "/fixture",
        helperPath: "/unused-helper",
        operationTimeoutMs: 100,
        generation: () => ({
          accountId: "fixture",
          owner: "fixture",
          generation: 1n,
          signal: new AbortController().signal,
          assert() {},
          valid: () => false,
          remainingMs: () => 0,
        }),
      },
      "provision",
      "fixture",
      [],
      {
        spawn() {
          throw new Error("unexpected spawn")
        },
        schedule() {
          throw new Error("unexpected timer")
        },
      },
    ),
  ).toThrow("lease expired")
})
