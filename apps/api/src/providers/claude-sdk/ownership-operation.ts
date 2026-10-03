import { type ChildProcess, spawn } from "node:child_process"

export interface OwnershipOperationDependencies {
  spawn(command: string, args: string[]): Pick<ChildProcess, "once" | "kill">
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
  config: { helperPath: string; root: string; operationTimeoutMs: number },
  mode: string,
  id: string,
  args: string[],
  dependencies: OwnershipOperationDependencies = defaults,
): Promise<number> {
  if (process.platform !== "linux") throw new Error("credential ownership requires Linux")
  return new Promise((resolve) => {
    const child = dependencies.spawn(config.helperPath, [mode, config.root, id, ...args])
    let settled = false
    let cancelTimer = () => {}
    const settle = (code: number) => {
      if (settled) return
      settled = true
      cancelTimer()
      resolve(code)
    }
    child.once("error", () => settle(70))
    child.once("exit", (code) => settle(code ?? 70))
    cancelTimer = dependencies.schedule(() => {
      // A termination request does not prove exit or filesystem quiescence.
      settle(70)
      try {
        child.kill("SIGKILL")
      } catch {
        // The deadline already reports uncertain ownership.
      }
    }, config.operationTimeoutMs)
  })
}
