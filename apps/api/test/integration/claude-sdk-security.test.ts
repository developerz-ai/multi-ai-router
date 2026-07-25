import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import {
  createQueryLaunch,
  PERMITTED_TOOLS,
  type SdkInvoker,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  subprocessEnv,
} from "../../src/providers"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { jsonResponse, subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, MESSAGE, post, settle } from "./harness"

/**
 * The build gate for docs/idea/07-security.md's highest-severity item: the Agent SDK executes tools
 * **only** on the client, never on this host. `bin/test` never spawns a real `claude` CLI, so every
 * assertion below exercises the same launch-time code (`options.ts`, `allowlist.ts`, `env.ts`,
 * `config-dir.ts`) that a real `query()` call would receive, with the SDK itself stubbed at the
 * `SdkInvoker` boundary — the seam `docs/idea/11-anthropic-agent-sdk.md` names for exactly this.
 *
 * Never skip, quarantine, or relax anything in this file to land an unrelated change
 * (docs/idea/07-security.md:49, CLAUDE.md non-negotiable 2).
 */

const HOST_TOOLS = ["Bash", "Read", "Write", "Edit", "Glob", "Grep"]

function launchFor(configDir: string, env: NodeJS.ProcessEnv = {}) {
  return createQueryLaunch({
    configDir,
    model: "claude-opus-5",
    cliPath: "/opt/claude/cli.js",
    signal: new AbortController().signal,
    inheritedEnv: env,
  })
}

/** Calls the launch's `canUseTool` gate without a non-null assertion — it must be set on every launch. */
function askToUseTool(
  launch: ReturnType<typeof launchFor>,
  toolName: string,
): Promise<PermissionResult> {
  const canUseTool = launch.options.canUseTool
  if (canUseTool === undefined) throw new Error("canUseTool must be set on every launch")
  return canUseTool(toolName, {}, { signal: new AbortController().signal })
}

describe("the tool allowlist a query() launch is given", () => {
  test("is empty, frozen, and a named literal — not computed or defaulted", () => {
    expect(PERMITTED_TOOLS).toEqual([])
    expect(Object.isFrozen(PERMITTED_TOOLS)).toBe(true)

    // Belt-and-suspenders against the regression this whole file guards: someone deriving the
    // allowlist from an env var or a config default instead of leaving one reviewed constant.
    const source = readFileSync(
      join(import.meta.dir, "../../src/providers/claude-sdk/allowlist.ts"),
      "utf8",
    )
    expect(source).toMatch(
      /export const PERMITTED_TOOLS: readonly string\[\] = Object\.freeze\(\[\]\)/,
    )
    expect(source).not.toMatch(/process\.env/)
  })

  test("the launch carries that exact list, never a wider one", () => {
    const launch = launchFor("/data/accounts/sub")
    expect(launch.options.allowedTools).toEqual([...PERMITTED_TOOLS])
    expect(launch.options.tools).toEqual([])
    expect(launch.options.permissionMode).toBe("dontAsk")
  })
})

describe("host-executing tool calls are rejected, not parked or run", () => {
  test.each(HOST_TOOLS)("%s is denied by the canUseTool gate", async (toolName) => {
    const launch = launchFor("/data/accounts/sub")
    const result = await askToUseTool(launch, toolName)

    expect(result.behavior).toBe("deny")
    if (result.behavior !== "deny") return
    expect(result.message).toContain(toolName)
    expect(result.message).toContain("client")
  })

  test("a name this build has never heard of is denied too — the list is closed, not a guess", async () => {
    const launch = launchFor("/data/accounts/sub")
    const result = await askToUseTool(launch, "SomeFutureBuiltin")
    expect(result.behavior).toBe("deny")
  })

  test("prototype names are refused, never resolved as an inherited permission", async () => {
    const launch = launchFor("/data/accounts/sub")
    for (const name of ["constructor", "toString", "hasOwnProperty"]) {
      const result = await askToUseTool(launch, name)
      expect(result.behavior).toBe("deny")
    }
  })
})

describe("subprocess isolation is set explicitly, verbatim, every launch", () => {
  test("settingSources: [] and tools: [] are the literal values, never omitted", () => {
    const launch = launchFor("/data/accounts/sub")
    expect(launch.options.settingSources).toEqual([])
    expect(launch.options.tools).toEqual([])
    expect(launch.options.strictMcpConfig).toBe(true)
    expect(launch.options.skills).toEqual([])
  })
})

describe("ANTHROPIC_* and router secrets never reach the child environment", () => {
  const poisoned: NodeJS.ProcessEnv = {
    ANTHROPIC_API_KEY: "sk-ant-leaked",
    ANTHROPIC_BASE_URL: "https://router.internal",
    ANTHROPIC_AUTH_TOKEN: "leaked-token",
    anthropic_extra_var: "still-stripped-case-insensitively",
    CLAUDE_CODE_OAUTH_TOKEN: "leaked-oauth",
    CLAUDE_CONFIG_DIR: "/wrong/account",
    ENCRYPTION_KEY: "leaked-encryption-key",
    DATABASE_URL: "postgres://leaked",
    ADMIN_PASSWORD: "leaked-admin-password",
    METRICS_TOKEN: "leaked-metrics-token",
    PATH: "/usr/bin",
    HOME: "/home/router",
  }

  test("subprocessEnv strips every ANTHROPIC_ prefix and every named router secret", () => {
    const env = subprocessEnv({ configDir: "/data/accounts/sub", inherited: poisoned })

    for (const key of Object.keys(env)) {
      expect(STRIPPED_ENV_PREFIXES.some((p) => key.toUpperCase().startsWith(p))).toBe(false)
    }
    for (const name of STRIPPED_ENV_NAMES) {
      // CLAUDE_CONFIG_DIR is stripped from whatever was *inherited* and then set fresh below — its
      // presence in the result is the guarantee, not a violation of it.
      if (name === "CLAUDE_CONFIG_DIR") continue
      expect(env).not.toHaveProperty(name)
    }
    // What a native binary and a JS runtime both need to resolve survives.
    expect(env.PATH).toBe("/usr/bin")
    expect(env.HOME).toBe("/home/router")
    // Set last, so no poisoned inherited value can win.
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/accounts/sub")
  })

  test("the same guarantee holds through the full query() launch, not just the helper", () => {
    const launch = launchFor("/data/accounts/sub", poisoned)
    const env = launch.options.env as Record<string, string>

    expect(Object.keys(env).some((k) => k.toUpperCase().startsWith("ANTHROPIC_"))).toBe(false)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
    expect(env.ENCRYPTION_KEY).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/accounts/sub")
  })
})

describe("two Accounts never share a CLAUDE_CONFIG_DIR", () => {
  test("provisioning two accounts yields two distinct directories, and two distinct launches", async () => {
    const ONE = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
    const TWO = "8ab4d2c1-6e39-4f70-b512-77c9e0a3d148"
    const memory = createMemoryConfigDirs()

    const dirOne = await memory.dirs.provision(ONE)
    const dirTwo = await memory.dirs.provision(TWO)
    expect(dirOne).not.toBe(dirTwo)

    const launchOne = launchFor(dirOne)
    const launchTwo = launchFor(dirTwo)

    expect(launchOne.options.cwd).toBe(dirOne)
    expect(launchTwo.options.cwd).toBe(dirTwo)
    expect(launchOne.options.cwd).not.toBe(launchTwo.options.cwd)

    const envOne = launchOne.options.env as Record<string, string>
    const envTwo = launchTwo.options.env as Record<string, string>
    expect(envOne.CLAUDE_CONFIG_DIR).toBe(dirOne)
    expect(envTwo.CLAUDE_CONFIG_DIR).toBe(dirTwo)
    expect(envOne.CLAUDE_CONFIG_DIR).not.toBe(envTwo.CLAUDE_CONFIG_DIR)
  })
})

describe("the request path never spawns a host process", () => {
  test("a subscription request is served entirely through the stubbed SdkInvoker boundary", async () => {
    const attempts: string[] = []
    const denials: string[] = []

    // Stands in for the real `query()` call: proves the SDK is invoked exactly at the seam the
    // codebase names for it (`SdkInvoker`), and that even if the model tried a host tool, the same
    // deny-by-default gate every launch carries would refuse it before anything ran on this host.
    const invokeSdk: SdkInvoker = async (invocation) => {
      attempts.push(invocation.accountId)
      const launch = launchFor(invocation.configDir)
      for (const toolName of HOST_TOOLS) {
        const result = await askToUseTool(launch, toolName)
        if (result.behavior === "deny") denials.push(toolName)
      }
      launch.detach()
      return jsonResponse(200, {
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
        model: invocation.model,
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      })
    }

    const { app, upstream, usage } = harness({
      accounts: [subscriptionAccount("sub-1", { configDir: "/data/accounts/sub-1" })],
      responses: [],
      invokeSdk,
    })

    const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
    await res.text()
    await settle()

    expect(res.status).toBe(200)
    expect(attempts).toEqual(["sub-1"])
    expect(denials).toEqual(HOST_TOOLS)
    // No URL was ever addressed — a subscription account never goes near `fetch`, which is the
    // other half of "no host process is spawned": no CLI, and no accidental HTTP fallback either.
    expect(upstream.calls).toHaveLength(0)
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]?.accountId).toBe("sub-1")
    expect(usage.rows[0]?.egressMode).toBe("agent-sdk")
  })
})
