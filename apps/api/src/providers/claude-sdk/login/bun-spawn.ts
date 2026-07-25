import type { LoginProcess, LoginSpawnInput } from "./spawn"

/**
 * The one place in the router that starts a `claude` process itself.
 *
 * Split out of `./spawn.ts` so that file stays a policy — deadlines, windowing, the handle's state
 * machine — testable against a `LoginSpawn` double. Everything here is untestable by construction
 * under CLAUDE.md's rules (`bin/test` may never spawn the CLI), so it is kept as thin as an adapter
 * can be: no branches, no buffering decisions, no interpretation of what the child said.
 */

export function bunLoginSpawn(input: LoginSpawnInput): LoginProcess {
  const child = Bun.spawn({
    cmd: [...input.command],
    cwd: input.cwd,
    // Replaced, never merged: `subprocessEnv` already decided what this child may see.
    env: input.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })

  return {
    output: mergeText(child.stdout, child.stderr),
    write: (chunk) => {
      child.stdin.write(chunk)
      // Unflushed, the code sits in a buffer while the CLI waits for a line that never arrives.
      child.stdin.flush()
    },
    exited: child.exited,
    kill: () => child.kill(),
  }
}

/**
 * Both pipes, decoded, in arrival order.
 *
 * Merged rather than read in sequence because which pipe carries the authorization URL is the
 * CLI's business, not ours — draining stdout to its end before looking at stderr would deadlock
 * against a CLI that prompts on the other one.
 */
function mergeText(...streams: readonly ReadableStream<Uint8Array>[]): AsyncIterable<string> {
  const queued: string[] = []
  let wake: (() => void) | null = null
  let open = streams.length

  const nudge = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }

  for (const stream of streams) {
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of stream) {
        queued.push(decoder.decode(chunk, { stream: true }))
        nudge()
      }
    })()
      // A closed pipe is the child going away, which `exited` reports better than a throw here.
      .catch(() => {})
      .finally(() => {
        open -= 1
        if (open === 0) nudge()
      })
  }

  return {
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queued.shift()
        if (next !== undefined) {
          yield next
          continue
        }
        if (open === 0) return
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      }
    },
  }
}
