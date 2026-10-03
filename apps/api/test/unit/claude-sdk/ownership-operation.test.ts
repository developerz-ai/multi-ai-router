import { expect, test } from "bun:test"
import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { createAccountCliOwnership } from "../../../src/providers/claude-sdk/account-ownership"

class DeferredExit extends EventEmitter {
  readonly signals: (string | number | undefined)[] = []
  kill(signal?: string | number) {
    this.signals.push(signal)
    return true
  }
}
test.skipIf(process.platform !== "linux")(
  "public cleanup deadline reports deferred without waiting for or claiming child exit",
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
        spawn: () => child as Pick<ChildProcess, "once" | "kill">,
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
    deadline()
    expect(await cleanup).toBe("deferred")
    expect(child.signals).toEqual(["SIGKILL"])
    expect(canceled).toBe(true)
    // Neither a late success nor a late spawn error can revise the unknown result.
    child.emit("exit", 0, null)
    child.emit("error", new Error("delayed termination"))
    expect(await cleanup).toBe("deferred")
  },
)
