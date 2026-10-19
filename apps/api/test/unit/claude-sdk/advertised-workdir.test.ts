import { describe, expect, test } from "bun:test"
import { createQueryLaunch } from "../../../src/providers/claude-sdk/options"

/**
 * What the client's model is told about the subprocess's working directory.
 *
 * The `claude` CLI stamps the subprocess cwd into the environment context it prepends to every
 * turn ("Working directory: …") — no test spawns a real CLI, so the launch `cwd` is captured at
 * the `query()` boundary and the advertised line is reconstructed from it. When the cwd was the
 * Account's config directory, that line named the router-side credential path *and* the Account's
 * internal id to any key holder's model, and misled it about where its tools run — they run on
 * the client (issue #296, docs/idea/07-security.md#subprocess-isolation).
 */

const ACCOUNT_ID = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const OTHER_ACCOUNT_ID = "8ab4d2c1-6e39-4f70-b512-77c9e0a3d148"
const ROOT = "/data/claude"
const CONFIG_DIR = `${ROOT}/${ACCOUNT_ID}`
/** The neutral workspace (`config-dir.ts` `WORKSPACE_DIR`), shared by every Account. */
const WORKSPACE = `${ROOT}/workspace`

function launchFor(configDir: string) {
  const launch = createQueryLaunch({
    configDir,
    model: "claude-opus-5",
    cliPath: "/opt/claude/claude",
    signal: new AbortController().signal,
  })
  launch.detach()
  return launch.options
}

/** The CLI's environment-context line, from the one input it is built from. */
function advertisedContext(cwd: unknown): string {
  return `Working directory: ${String(cwd)}\nIs directory a git repo: No`
}

describe("the working directory advertised to the client's model", () => {
  test("carries neither the Account's id nor its config-dir path", () => {
    const context = advertisedContext(launchFor(CONFIG_DIR).cwd)

    expect(context).not.toContain(ACCOUNT_ID)
    expect(context).not.toContain(CONFIG_DIR)
  })

  test("is one neutral workspace, identical for every Account", () => {
    expect(launchFor(CONFIG_DIR).cwd).toBe(WORKSPACE)
    expect(launchFor(`${ROOT}/${OTHER_ACCOUNT_ID}`).cwd).toBe(WORKSPACE)
  })

  test("leaves per-Account CLAUDE_CONFIG_DIR isolation unchanged", () => {
    const one = launchFor(CONFIG_DIR).env as Record<string, string>
    const two = launchFor(`${ROOT}/${OTHER_ACCOUNT_ID}`).env as Record<string, string>

    expect(one.CLAUDE_CONFIG_DIR).toBe(CONFIG_DIR)
    expect(two.CLAUDE_CONFIG_DIR).toBe(`${ROOT}/${OTHER_ACCOUNT_ID}`)
    expect(one.CLAUDE_CONFIG_DIR).not.toBe(two.CLAUDE_CONFIG_DIR)
  })
})
