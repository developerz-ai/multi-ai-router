import { subprocessEnv } from "../env"
import { bunLoginSpawn } from "./bun-spawn"
import type { ClaudeAuthCheck, ClaudeAuthStatus } from "./contract"
import { CLAUDE_AUTH_STATUS_ARGV, LOGIN_ENV_OVERRIDES, readAuthStatus } from "./scrape"
import type { LoginProcess, LoginSpawn } from "./spawn"

/**
 * Running `claude auth status` against one Account's `CLAUDE_CONFIG_DIR`.
 *
 * The cheapest honest question this router can ask about a subscription: the CLI reads the
 * credential file it wrote itself and says whether it is still a login. No provider is contacted,
 * nothing is billed, and — as everywhere else on this path — the token stays on the far side of the
 * subprocess boundary. What comes back is three fields and a boolean
 * (docs/idea/11-anthropic-agent-sdk.md §3).
 *
 * Sibling of `./spawn.ts` and deliberately much smaller: a status check is one shot with no stdin,
 * no handshake, and no handle. What it does share is the shape that makes the login safe — output
 * drained for the child's whole life, the buffer windowed rather than accumulated, and every exit
 * bounded — because a probe that can wedge is worse than no probe.
 *
 * **Silence is reported as silence.** Every failure here returns `null`, never `loggedIn: false`.
 * A missing binary, a timeout, or output this router cannot read must not mark healthy Accounts
 * `needs_reauth` (`contract.ts`, {@link ClaudeAuthCheck}).
 */

/** How long the CLI gets to read a local file and print a line. Not a user-facing wait. */
export const AUTH_STATUS_TIMEOUT_MS = 15_000

/** How much of the child's output is kept. The payload is a few hundred bytes; this is slack. */
export const AUTH_STATUS_WINDOW_BYTES = 8 * 1024

/** After the child is gone its pipes close immediately; this bounds the case where they do not. */
const DRAIN_GRACE_MS = 1_000

export interface ClaudeAuthCheckOptions {
  /** Which `claude` binary to run — `resolveClaudeCli`'s answer, the same one the SDK spawns. */
  readonly cliPath: string
  /** What the child inherits from, minus what `../env.ts` strips. Defaults to `process.env`. */
  readonly inheritedEnv?: NodeJS.ProcessEnv
  readonly timeoutMs?: number
  /** Defaults to {@link bunLoginSpawn}. Injected in tests, which must never start a binary. */
  readonly spawn?: LoginSpawn
}

export function createClaudeAuthCheck(options: ClaudeAuthCheckOptions): ClaudeAuthCheck {
  const spawn = options.spawn ?? bunLoginSpawn
  const timeoutMs = options.timeoutMs ?? AUTH_STATUS_TIMEOUT_MS

  return {
    check: async (configDir) => {
      let child: LoginProcess
      try {
        child = spawn({
          command: [options.cliPath, ...CLAUDE_AUTH_STATUS_ARGV],
          cwd: configDir,
          env: {
            ...subprocessEnv({ configDir, inherited: options.inheritedEnv }),
            ...LOGIN_ENV_OVERRIDES,
          },
        })
      } catch {
        // A binary that will not start is the operator's problem to see in `/readyz`, not a fact
        // about the Account's credential.
        return null
      }

      return collect(child, timeoutMs)
    },
  }
}

/**
 * Drains the child, waits for it to end, and reads whatever window is left.
 *
 * Parsed regardless of exit code: the CLI exits `0` for logged in *and* logged out, so a non-zero
 * exit carries no information the output does not already carry better.
 */
async function collect(child: LoginProcess, timeoutMs: number): Promise<ClaudeAuthStatus | null> {
  let window = ""
  const drained = (async () => {
    try {
      for await (const chunk of child.output) {
        window = (window + chunk).slice(-AUTH_STATUS_WINDOW_BYTES)
      }
    } catch {
      // A broken pipe is the child going away, which the exit below reports better than a throw.
    }
  })()

  const exited = await settle(child.exited, timeoutMs)
  // Killed on both paths: on a timeout it is the point, and after a clean exit it is a no-op that
  // costs nothing and closes the case where the child forked something holding the pipe open.
  child.kill()
  await settle(drained, DRAIN_GRACE_MS)

  return exited ? readAuthStatus(window) : null
}

/** Resolves true when `work` finished inside `ms`, false when the timer won. Never rejects. */
async function settle(work: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([work.then(() => true).catch(() => true), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
