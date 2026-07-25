import { describe, expect, test } from "bun:test"
import {
  type ClaudeCliLogin,
  ClaudeLoginError,
  createClaudeCliLogin,
  type LoginProcess,
  type LoginSpawnInput,
} from "../../../src/providers/claude-sdk/login"

/**
 * The login handle's state machine, against a fake process.
 *
 * No `claude` binary is started here and none may be (CLAUDE.md testing rules) — the `LoginSpawn`
 * seam exists for exactly this, so the deadlines, the windowing, and the kill-on-every-failure rule
 * are all testable without one.
 *
 * The assertions that matter most are the ones about what is left behind: every failure path must
 * terminate the subprocess, and nothing that reaches an error may carry credential material.
 */

const CLI = "/usr/local/bin/claude"
const DIR = "/data/claude/8e0d3f4a-0000-4000-8000-00000000abcd"
const STATE = "s-9f2c1"
const URL = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=${STATE}`

interface FakeChild extends LoginProcess {
  /** Pushes a chunk onto the merged output stream. */
  emit(text: string): void
  /** Closes the output stream and exits with `code`. */
  exit(code: number): void
  readonly written: string[]
  readonly stats: { kills: number }
}

function fakeChild(): FakeChild {
  const queued: string[] = []
  const written: string[] = []
  const stats = { kills: 0 }
  let wake: (() => void) | null = null
  let open = true
  let settle: (code: number) => void = () => {}
  const exited = new Promise<number>((resolve) => {
    settle = resolve
  })

  const nudge = (): void => {
    const resume = wake
    wake = null
    resume?.()
  }
  const close = (code: number): void => {
    open = false
    nudge()
    settle(code)
  }

  return {
    output: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queued.shift()
          if (next !== undefined) {
            yield next
            continue
          }
          if (!open) return
          await new Promise<void>((resolve) => {
            wake = resolve
          })
        }
      },
    },
    write: (chunk) => {
      if (!open) throw new Error("EPIPE")
      written.push(chunk)
    },
    exited,
    kill: () => {
      stats.kills += 1
      if (open) close(143)
    },
    emit: (text) => {
      queued.push(text)
      nudge()
    },
    exit: close,
    written,
    stats,
  }
}

interface Harness {
  readonly login: ClaudeCliLogin
  readonly child: FakeChild
  readonly launched: LoginSpawnInput[]
}

function harness(options: { inheritedEnv?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Harness {
  const child = fakeChild()
  const launched: LoginSpawnInput[] = []
  const login = createClaudeCliLogin({
    cliPath: CLI,
    inheritedEnv: options.inheritedEnv ?? {},
    authorizeUrlTimeoutMs: options.timeoutMs ?? 1_000,
    exchangeTimeoutMs: options.timeoutMs ?? 1_000,
    spawn: (input) => {
      launched.push(input)
      return child
    },
  })
  return { login, child, launched }
}

async function started(h: Harness, output = `Open this URL:\n${URL}\n`) {
  const pending = h.login.start({ configDir: DIR })
  h.child.emit(output)
  return await pending
}

/** Lets the reader loop drain what the fake child has queued, as a real one would as bytes land. */
function tick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

async function caught(work: Promise<unknown>): Promise<ClaudeLoginError> {
  const error = await work.then(
    () => null,
    (thrown: unknown) => thrown,
  )
  if (!(error instanceof ClaudeLoginError)) throw new Error(`expected a login error, got ${error}`)
  return error
}

describe("starting the CLI's login", () => {
  test("runs the pinned subcommand against the account's config directory", async () => {
    const h = harness()
    await started(h)

    expect(h.launched).toHaveLength(1)
    expect(h.launched[0]?.command).toEqual([CLI, "auth", "login", "--claudeai"])
    expect(h.launched[0]?.cwd).toBe(DIR)
  })

  test("hands the child this account's directory and strips what would leak into it", async () => {
    const h = harness({
      inheritedEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "sk-should-never-reach-the-child",
        ANTHROPIC_BASE_URL: "http://router.internal",
        CLAUDE_CODE_OAUTH_TOKEN: "fake-host-token",
        ENCRYPTION_KEY: "fake-encryption-key",
        CLAUDE_CONFIG_DIR: "/home/router/.claude",
      },
    })
    await started(h)

    const env = h.launched[0]?.env ?? {}
    expect(env.CLAUDE_CONFIG_DIR).toBe(DIR)
    expect(env.PATH).toBe("/usr/bin")
    expect(env.NO_COLOR).toBe("1")
    expect(env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined()
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ENCRYPTION_KEY).toBeUndefined()
  })

  test("returns the URL the CLI printed and the state inside it", async () => {
    const handle = await started(harness())

    expect(handle.authorizeUrl).toBe(URL)
    expect(handle.state).toBe(STATE)
  })

  test("finds the URL on stderr as readily as on stdout", async () => {
    const handle = await started(harness(), `warning: no browser found\n${URL}\n`)
    expect(handle.authorizeUrl).toBe(URL)
  })

  test("a CLI that exits without a URL is a named failure, not a hang", async () => {
    const h = harness()
    const pending = h.login.start({ configDir: DIR })
    h.child.emit("could not reach claude.ai\n")
    h.child.exit(1)

    expect((await caught(pending)).kind).toBe("no_authorize_url")
  })

  test("a URL with no state is refused rather than left unbound", async () => {
    const h = harness()
    const pending = h.login.start({ configDir: DIR })
    h.child.emit("https://claude.com/cai/oauth/authorize?client_id=abc\n")
    h.child.exit(0)

    expect((await caught(pending)).kind).toBe("no_authorize_url")
  })

  test("a silent CLI is terminated by its deadline", async () => {
    const h = harness({ timeoutMs: 5 })
    const error = await caught(h.login.start({ configDir: DIR }))

    expect(error.kind).toBe("timeout")
    expect(h.child.stats.kills).toBeGreaterThan(0)
  })

  test("a binary that will not start says so", async () => {
    const login = createClaudeCliLogin({
      cliPath: CLI,
      inheritedEnv: {},
      spawn: () => {
        throw new Error("ENOENT /usr/local/bin/claude")
      },
    })

    const error = await caught(login.start({ configDir: DIR }))
    expect(error.kind).toBe("cli_unavailable")
    expect(error.message).not.toContain("ENOENT")
  })
})

describe("completing the login", () => {
  test("writes the pasted value as a line on the CLI's stdin", async () => {
    const h = harness()
    const handle = await started(h)

    const pending = handle.submit("ac_123#s-9f2c1")
    h.child.exit(0)
    await pending

    expect(h.child.written).toEqual(["ac_123#s-9f2c1\n"])
  })

  test("a non-zero exit is a rejected code, not a router failure", async () => {
    const h = harness()
    const handle = await started(h)

    const pending = handle.submit("ac_wrong#s-9f2c1")
    h.child.emit("invalid authorization code\n")
    h.child.exit(1)

    const error = await caught(pending)
    expect(error.kind).toBe("login_rejected")
    expect(error.logDetail).toContain("invalid authorization code")
  })

  test("the handle is one-shot", async () => {
    const h = harness()
    const handle = await started(h)

    const pending = handle.submit("ac_123#s-9f2c1")
    h.child.exit(0)
    await pending

    expect((await caught(handle.submit("ac_123#s-9f2c1"))).kind).toBe("login_rejected")
    expect(h.child.written).toHaveLength(1)
  })

  test("a CLI that already went away is a rejection, not an unhandled throw", async () => {
    const h = harness()
    const handle = await started(h)
    h.child.exit(0)

    expect((await caught(handle.submit("ac_123#s-9f2c1"))).kind).toBe("login_rejected")
  })

  test("a CLI that never finishes the exchange is terminated by its deadline", async () => {
    const h = harness({ timeoutMs: 5 })
    const handle = await started(h)

    const error = await caught(handle.submit("ac_123#s-9f2c1"))
    expect(error.kind).toBe("timeout")
    expect(h.child.stats.kills).toBeGreaterThan(0)
  })

  test("cancelling terminates the subprocess and stays cancelled", async () => {
    const h = harness()
    const handle = await started(h)

    handle.cancel()
    handle.cancel()

    expect(h.child.stats.kills).toBe(2)
    expect((await caught(handle.submit("ac_123#s-9f2c1"))).kind).toBe("login_rejected")
  })
})

describe("what the CLI's output is allowed to become", () => {
  /**
   * The login stream is the one place in the router a subscription token can appear. The redactor
   * runs at the source, so a value that looks like a credential cannot reach a log line even
   * through the diagnostic tail — CLAUDE.md non-negotiable 3.
   */
  test("the tail an error carries is redacted", async () => {
    const h = harness()
    const handle = await started(h)

    const pending = handle.submit("ac_123#s-9f2c1")
    h.child.emit("wrote sk-ant-oat01-notarealtokenvalue to disk\n")
    h.child.exit(1)

    const error = await caught(pending)
    expect(error.logDetail).not.toContain("sk-ant-oat01-notarealtokenvalue")
    expect(error.logDetail).toContain("[REDACTED]")
  })

  test("the pipe keeps draining after the URL, so a chatty CLI cannot block", async () => {
    const h = harness()
    const handle = await started(h)

    for (let i = 0; i < 500; i += 1) h.child.emit(`progress line ${i}\n`)
    await tick()
    const pending = handle.submit("ac_123#s-9f2c1")
    h.child.emit("final word\n")
    await tick()
    h.child.exit(1)

    // Only the tail survives the window, which is the proof it was read and not accumulated.
    const error = await caught(pending)
    expect(error.logDetail).toContain("final word")
    expect(error.logDetail).not.toContain("progress line 0\n")
    expect((error.logDetail ?? "").length).toBeLessThanOrEqual(512)
  })
})
