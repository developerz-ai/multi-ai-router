import { redactValue } from "../../../logging/redact"
import { subprocessEnv } from "../env"
import { bunLoginSpawn } from "./bun-spawn"
import {
  type ClaudeCliLogin,
  ClaudeLoginError,
  type ClaudeLoginFailureKind,
  type ClaudeLoginHandle,
  type ClaudeLoginStartInput,
} from "./contract"
import { CLAUDE_LOGIN_ARGV, findAuthorizeUrl, LOGIN_ENV_OVERRIDES, readState } from "./scrape"

/**
 * Driving the real `claude` binary through its login, one subprocess per Account.
 *
 * The subprocess is the credential boundary. Everything sensitive — the PKCE verifier, the code
 * exchange, the token, the write of `.credentials.json` — happens on the far side of it, in the
 * Account's own `CLAUDE_CONFIG_DIR`. This side keeps exactly two strings: the authorization URL and
 * the `state` inside it.
 *
 * Three properties the plumbing exists for, none of them optional:
 *
 * - **The pipe is always being drained.** One reader runs from spawn to exit. A child that fills a
 *   pipe nobody is reading blocks forever on its own `write`, which would look exactly like a login
 *   the operator never finished, on every connect, once the CLI's output grew past 64 KiB.
 * - **Output is windowed, never accumulated.** The buffer is capped and the tail is redacted before
 *   it can reach an error, because this is the one stream in the router that can carry a
 *   subscription token, and "we only looked for a URL in it" is not a property a `string` has.
 * - **Every exit is bounded.** A CLI waiting on a prompt nobody will answer is terminated by its
 *   deadline rather than left holding a process slot until the container restarts.
 *
 * `spawn` is injected so `bin/test` never starts a `claude` binary (CLAUDE.md testing rules); the
 * Bun adapter below is the only thing in the router that does.
 */

/** One child process, reduced to what a login needs. Merged output, stdin, exit, kill. */
export interface LoginProcess {
  /** stdout and stderr, decoded, in arrival order. Ends when the child's pipes close. */
  readonly output: AsyncIterable<string>
  /** Writes to the child's stdin. Throws if it has already gone. */
  write(chunk: string): void
  readonly exited: Promise<number>
  /** Terminates the child. Idempotent. */
  kill(): void
}

export interface LoginSpawnInput {
  /** Executable first, then arguments — the shape `Bun.spawn` takes. */
  readonly command: readonly string[]
  readonly cwd: string
  /** The whole environment the child gets. Never merged with this process's own. */
  readonly env: Record<string, string>
}

export type LoginSpawn = (input: LoginSpawnInput) => LoginProcess

/**
 * How much of the CLI's output is kept at any moment. It is both the window a URL is matched in and
 * the source of the redacted tail an error carries, so one buffer serves both and neither grows.
 *
 * A named bound rather than an operator knob: it is what makes the reader O(1) in a stream the
 * router does not control, not a capacity anyone would tune.
 */
export const OUTPUT_WINDOW_BYTES = 8 * 1024

/** How much of that window an error may carry. */
export const LOG_DETAIL_BYTES = 512

/** How long the CLI gets to print its authorization URL. A handshake bound, not a user-facing wait. */
export const AUTHORIZE_URL_TIMEOUT_MS = 30_000

/** How long the CLI gets to finish the exchange once the pasted code is on its stdin. */
export const EXCHANGE_TIMEOUT_MS = 60_000

export interface ClaudeCliLoginOptions {
  /** Which `claude` binary to run — `resolveClaudeCli`'s answer, the same one the SDK spawns. */
  readonly cliPath: string
  /** What the child inherits from, minus what `../env.ts` strips. Defaults to `process.env`. */
  readonly inheritedEnv?: NodeJS.ProcessEnv
  readonly authorizeUrlTimeoutMs?: number
  readonly exchangeTimeoutMs?: number
  /** Defaults to {@link bunLoginSpawn}. Injected in tests, which must never start a binary. */
  readonly spawn?: LoginSpawn
}

export function createClaudeCliLogin(options: ClaudeCliLoginOptions): ClaudeCliLogin {
  const spawn = options.spawn ?? bunLoginSpawn
  const urlTimeout = options.authorizeUrlTimeoutMs ?? AUTHORIZE_URL_TIMEOUT_MS
  const exchangeTimeout = options.exchangeTimeoutMs ?? EXCHANGE_TIMEOUT_MS

  return {
    start: async (input) => {
      const child = launch(spawn, options, input)
      const reader = readOutput(child)

      const url = await deadline(
        Promise.race([reader.authorizeUrl, reader.finished]),
        urlTimeout,
        () => reader.error("timeout", "the claude CLI did not respond in time"),
      ).catch((error: unknown) => {
        // Killed here rather than inside the deadline: terminating the child ends the output
        // stream, which resolves the very race the timeout is trying to lose — and a timeout that
        // reports itself as "exited without a URL" points an operator at the wrong thing.
        child.kill()
        throw error instanceof ClaudeLoginError
          ? error
          : reader.error("cli_unavailable", "the claude CLI could not be read")
      })

      if (url === null) {
        throw fail(
          child,
          reader,
          "no_authorize_url",
          "the claude CLI exited without printing an authorization URL",
        )
      }
      const state = readState(url)
      if (state === null) {
        throw fail(
          child,
          reader,
          "unbound_state",
          "the authorization URL carried no state, so this login cannot be bound to the account",
        )
      }

      return handle(child, reader, url, state, exchangeTimeout)
    },
  }
}

function launch(
  spawn: LoginSpawn,
  options: ClaudeCliLoginOptions,
  input: ClaudeLoginStartInput,
): LoginProcess {
  try {
    return spawn({
      command: [options.cliPath, ...CLAUDE_LOGIN_ARGV],
      cwd: input.configDir,
      env: {
        ...subprocessEnv({ configDir: input.configDir, inherited: options.inheritedEnv }),
        ...LOGIN_ENV_OVERRIDES,
      },
    })
  } catch {
    // The thrown value names a path on this host and is worthless to an operator besides.
    throw new ClaudeLoginError("cli_unavailable", "the claude CLI could not be started")
  }
}

function handle(
  child: LoginProcess,
  reader: OutputReader,
  authorizeUrl: string,
  state: string,
  exchangeTimeoutMs: number,
): ClaudeLoginHandle {
  let spent = false

  const cancel = (): void => {
    spent = true
    child.kill()
  }

  return {
    authorizeUrl,
    state,
    submit: async (codeAndState) => {
      if (spent) {
        throw new ClaudeLoginError(
          "login_rejected",
          "this login was already completed or cancelled",
        )
      }
      spent = true

      try {
        child.write(`${codeAndState}\n`)
      } catch {
        throw fail(
          child,
          reader,
          "login_rejected",
          "the claude CLI stopped before the code reached it",
        )
      }

      const code = await deadline(child.exited, exchangeTimeoutMs, () =>
        reader.error("timeout", "the claude CLI did not finish the login in time"),
      ).catch((error: unknown) => {
        child.kill()
        throw error
      })
      if (code !== 0) {
        throw reader.error(
          "login_rejected",
          "the claude CLI did not accept that authorization code",
        )
      }
    },
    cancel,
  }
}

interface OutputReader {
  /** Resolves with the first authorization URL seen. Never rejects, never resolves without one. */
  readonly authorizeUrl: Promise<string>
  /** Resolves with the URL, or null if the stream ended without one. Never rejects. */
  readonly finished: Promise<string | null>
  /**
   * A failure carrying the redacted tail of the current window. Building the error is separate
   * from terminating the child so a caller can choose the order, which the deadlines depend on.
   */
  error(kind: ClaudeLoginFailureKind, message: string): ClaudeLoginError
}

/**
 * The single reader. Started at spawn and never stopped early, so the child's pipe is drained for
 * its whole life rather than only until the URL appears.
 */
function readOutput(child: LoginProcess): OutputReader {
  let announce: (url: string) => void = () => {}
  const authorizeUrl = new Promise<string>((resolve) => {
    announce = resolve
  })
  let window = ""

  const finished = (async (): Promise<string | null> => {
    let found: string | null = null
    try {
      for await (const chunk of child.output) {
        window = (window + chunk).slice(-OUTPUT_WINDOW_BYTES)
        if (found !== null) continue
        found = findAuthorizeUrl(window)
        if (found !== null) announce(found)
      }
    } catch {
      // A broken pipe is the child going away, which `exited` reports better than this does.
    }
    return found
  })()

  return {
    authorizeUrl,
    finished,
    error: (kind, message) =>
      new ClaudeLoginError(kind, message, redactValue(window).slice(-LOG_DETAIL_BYTES)),
  }
}

/** Builds the error, then kills — so no path leaves a subprocess behind a rejection. */
function fail(
  child: LoginProcess,
  reader: OutputReader,
  kind: ClaudeLoginFailureKind,
  message: string,
): ClaudeLoginError {
  const error = reader.error(kind, message)
  child.kill()
  return error
}

async function deadline<T>(work: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(onTimeout()), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
