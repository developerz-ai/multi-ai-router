import type { ChildProcess } from "node:child_process"
import { basename, join } from "node:path"
import { PassThrough } from "node:stream"
import type { OwnerLaunchFactory } from "../owned-query"
import { createOwnerLaunch, type OwnerLaunchConfig } from "../owner-launch"
import type { LoginProcess, LoginSpawn } from "./spawn"

/** Login/status use the same guardian as SDK inference; no credential is read here. */
export function createOwnedLoginSpawn(
  config: OwnerLaunchConfig,
  ownerLaunch: OwnerLaunchFactory = (id) => createOwnerLaunch(config, id),
): LoginSpawn {
  return (input): LoginProcess => {
    const accountId = input.accountId ?? basename(input.cwd)
    if (input.cwd !== join(config.root, accountId))
      throw new Error("credential directory authority mismatch")
    const scope = ownerLaunch(accountId)
    const child = scope.spawn({
      command: input.command[0] ?? "",
      args: [...input.command.slice(1)],
      cwd: input.cwd,
      env: input.env,
      signal: input.signal ?? new AbortController().signal,
    }) as ChildProcess
    const merged = new PassThrough()
    let pipes = 2
    for (const pipe of [child.stdout, child.stderr]) {
      if (!pipe) throw new Error("credential owner output unavailable")
      pipe.pipe(merged, { end: false })
      pipe.once("end", () => {
        pipes--
        if (!pipes) merged.end()
      })
      pipe.once("error", () => merged.destroy(new Error("credential owner output unavailable")))
    }
    const exited = new Promise<number>((resolve, reject) => {
      child.once("error", () => reject(new Error("credential owner unavailable")))
      child.once("exit", (code, signal) => {
        if (signal) reject(new Error("credential owner exit is uncertain"))
        else resolve(code ?? 70)
      })
    })
    const confirmedExit = exited.then(async (code) => {
      await scope.exited
      return code
    })
    void confirmedExit.catch(() => {})
    void exited.catch(() => {})
    void scope.ready
      .then(async () => {
        await scope.prepare()
        input.signal?.throwIfAborted()
        scope.activate()
      })
      .catch(() => scope.cancel())
    return {
      output: {
        async *[Symbol.asyncIterator]() {
          const decoder = new TextDecoder()
          for await (const data of merged) yield decoder.decode(data, { stream: true })
          const tail = decoder.decode()
          if (tail) yield tail
        },
      },
      write(value) {
        if (!child.stdin || child.stdin.destroyed)
          throw new Error("credential owner stdin unavailable")
        child.stdin.write(value)
      },
      exited: confirmedExit,
      kill: scope.cancel,
    }
  }
}
