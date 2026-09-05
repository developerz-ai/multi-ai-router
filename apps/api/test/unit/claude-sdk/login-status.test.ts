import { describe, expect, test } from "bun:test"
import {
  CLAUDE_AUTH_STATUS_ARGV,
  createClaudeAuthCheck,
  type LoginProcess,
  type LoginSpawnInput,
} from "../../../src/providers/claude-sdk/login"

/**
 * `claude auth status --json` against one Account's directory (`login/status.ts`), with the CLI
 * stubbed at the spawn seam — no binary runs. The properties that matter: the answer is read off
 * the JSON the CLI prints and nothing else, silence of every kind is `null` rather than "logged
 * out", the child is bounded and killed, and the environment it gets is the Account's own.
 */

const CLI = "/usr/local/bin/claude"
const DIR = "/data/claude/8e0d3f4a-0000-4000-8000-00000000abcd"

interface FakeChild extends LoginProcess {
  emit(text: string): void
  exit(code: number): void
  readonly stats: { kills: number }
}

function fakeChild(): FakeChild {
  const queued: string[] = []
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
    write: () => {
      throw new Error("status takes no stdin")
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
    stats,
  }
}

function harness(
  options: { timeoutMs?: number; inheritedEnv?: NodeJS.ProcessEnv; refuse?: boolean } = {},
) {
  const child = fakeChild()
  const launched: LoginSpawnInput[] = []
  const check = createClaudeAuthCheck({
    cliPath: CLI,
    inheritedEnv: options.inheritedEnv ?? {},
    timeoutMs: options.timeoutMs ?? 1_000,
    spawn: (input) => {
      launched.push(input)
      if (options.refuse === true) throw new Error("ENOENT")
      return child
    },
  })
  return { check, child, launched }
}

async function answered(output: string, code = 0) {
  const h = harness()
  const pending = h.check.check(DIR)
  h.child.emit(output)
  h.child.exit(code)
  return { status: await pending, h }
}

describe("asking the CLI whether an account is logged in", () => {
  test("runs the pinned subcommand in the account's directory with its own environment", async () => {
    const h = harness({ inheritedEnv: { ANTHROPIC_API_KEY: "sk-ant-inherited", PATH: "/usr/bin" } })
    const pending = h.check.check(DIR)
    h.child.emit('{"loggedIn":true}\n')
    h.child.exit(0)
    await pending

    const launch = h.launched[0]
    expect(launch?.command).toEqual([CLI, ...CLAUDE_AUTH_STATUS_ARGV])
    expect(launch?.cwd).toBe(DIR)
    expect(launch?.env.CLAUDE_CONFIG_DIR).toBe(DIR)
    // The inherited Anthropic credential must never reach a subprocess speaking for another login.
    expect(Object.keys(launch?.env ?? {}).some((key) => key.startsWith("ANTHROPIC_"))).toBe(false)
  })

  test("reads a logged-in answer, with the plan and the email the CLI reports", async () => {
    const { status } = await answered(
      'Deprecation notice: something\n{"loggedIn":true,"email":"op@example.com","subscriptionType":"max"}\n',
    )
    expect(status).toEqual({ loggedIn: true, email: "op@example.com", subscriptionType: "max" })
  })

  test("reads a logged-out answer as exactly that, whatever the exit code", async () => {
    const { status } = await answered('{"loggedIn":false}\n', 1)
    expect(status).toEqual({ loggedIn: false, email: null, subscriptionType: null })
  })

  test("output this router cannot read is silence, never a logged-out account", async () => {
    const { status } = await answered("Segmentation fault\n", 139)
    expect(status).toBeNull()
  })

  test("a child that never exits is killed at the deadline and answers nothing", async () => {
    const h = harness({ timeoutMs: 20 })
    const status = await h.check.check(DIR)
    expect(status).toBeNull()
    expect(h.child.stats.kills).toBeGreaterThan(0)
  })

  test("a binary that will not start is silence too", async () => {
    const h = harness({ refuse: true })
    expect(await h.check.check(DIR)).toBeNull()
  })

  test("the child is killed after a clean exit as well, so nothing it forked holds the pipe", async () => {
    const { h } = await answered('{"loggedIn":true}\n')
    expect(h.child.stats.kills).toBe(1)
  })
})
