import { type ChildProcess, spawn } from "node:child_process"
import { ownerMonotonicMilliseconds } from "./owner-clock"
import type { ReplicaGenerationHandle } from "./replica-lease"

export interface OwnershipOperationDependencies {
  spawn(command: string, args: string[]): Pick<ChildProcess, "once" | "kill"> & { pid?: number }
  schedule(callback: () => void, timeoutMs: number): () => void
}
const defaults: OwnershipOperationDependencies = {
  spawn: (command, args) => spawn(command, args, { stdio: "ignore" }),
  schedule(callback, timeoutMs) {
    const timer = setTimeout(callback, timeoutMs)
    return () => clearTimeout(timer)
  },
}
export function ownershipOperation(
  config: {
    helperPath: string
    root: string
    operationTimeoutMs: number
    generation?: (accountId: string) => ReplicaGenerationHandle
  },
  mode: string,
  id: string,
  args: string[],
  dependencies: OwnershipOperationDependencies = defaults,
): Promise<number> {
  if (process.platform !== "linux") throw new Error("credential ownership requires Linux")
  const generation = config.generation?.(id)
  generation?.assert()
  const sampled = generation ? ownerMonotonicMilliseconds() : 0n
  const remaining = Math.floor(
    Math.min(config.operationTimeoutMs, generation?.remainingMs() ?? config.operationTimeoutMs),
  )
  if (remaining <= 0) throw new Error("credential operation lease expired")
  const authority = generation
    ? [generation.owner, String(generation.generation), String(sampled + BigInt(remaining))]
    : []
  return new Promise((resolve) => {
    const child = dependencies.spawn(config.helperPath, [
      generation ? `${mode}-fenced` : mode,
      config.root,
      id,
      ...authority,
      ...args,
    ])
    let settled = false
    let cancelTimer = () => {}
    let timedOut = false
    const cancel = () => {
      timedOut = true
      try {
        child.kill("SIGKILL")
      } catch {
        /* Exit remains unconfirmed. */
      }
    }
    const settle = (code: number) => {
      if (settled) return
      settled = true
      cancelTimer()
      generation?.signal.removeEventListener("abort", cancel)
      resolve(code)
    }
    child.once("error", () => {
      if (child.pid === undefined) settle(70)
      else cancel()
    })
    child.once("exit", (code) =>
      settle(timedOut || (generation && !generation.valid()) ? 70 : (code ?? 70)),
    )
    generation?.signal.addEventListener("abort", cancel, { once: true })
    cancelTimer = dependencies.schedule(cancel, remaining)
    if (generation?.signal.aborted) cancel()
  })
}
