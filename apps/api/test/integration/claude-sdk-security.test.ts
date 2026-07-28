import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Options, PermissionResult } from "@anthropic-ai/claude-agent-sdk"
import { createApp } from "../../src/app"
import { createLogger } from "../../src/logging/logger"
import {
  type CliResolution,
  createPassthrough,
  createQueryLaunch,
  createSdkConcurrency,
  createSdkInvoker,
  PASSTHROUGH_SERVER_NAME,
  PERMITTED_TOOLS,
  qualifyToolName,
  type SdkInvoker,
  STRIPPED_ENV_NAMES,
  STRIPPED_ENV_PREFIXES,
  subprocessEnv,
} from "../../src/providers"
import { createMemoryConfigDirs } from "../support/config-dirs"
import { sdkQueryStream, sdkTurn } from "../unit/claude-sdk/fixtures"
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

describe("registering the client's own tools widens nothing", () => {
  const passthrough = createPassthrough({
    tools: [{ name: "get_weather", description: "d", input_schema: { type: "object" } }],
  })

  function launchWithPassthrough() {
    if (passthrough === null) throw new Error("a client that declared tools must get a passthrough")
    return createQueryLaunch({
      configDir: "/data/accounts/sub",
      model: "claude-opus-5",
      cliPath: "/opt/claude/cli.js",
      signal: new AbortController().signal,
      inheritedEnv: {},
      passthrough,
    })
  }

  test("the allowlist, the empty base tool set, and every isolation flag are unchanged", () => {
    const launch = launchWithPassthrough()
    expect(launch.options.allowedTools).toEqual([...PERMITTED_TOOLS])
    expect(launch.options.tools).toEqual([])
    expect(launch.options.permissionMode).toBe("dontAsk")
    expect(launch.options.settingSources).toEqual([])
    expect(launch.options.strictMcpConfig).toBe(true)
    expect(launch.options.skills).toEqual([])
    expect(Object.keys(launch.options.mcpServers ?? {})).toEqual([PASSTHROUGH_SERVER_NAME])
  })

  test("a registered client tool is denied by canUseTool exactly like a built-in", async () => {
    const launch = launchWithPassthrough()
    const result = await askToUseTool(launch, qualifyToolName("get_weather"))
    expect(result.behavior).toBe("deny")
  })

  test("host-executing built-ins stay denied with the client's tools registered", async () => {
    const launch = launchWithPassthrough()
    for (const toolName of HOST_TOOLS) {
      expect((await askToUseTool(launch, toolName)).behavior).toBe("deny")
    }
  })

  test("the PreToolUse hook denies every call it sees, including a host built-in", async () => {
    if (passthrough === null) throw new Error("a client that declared tools must get a passthrough")
    const hook = passthrough.hooks.PreToolUse?.[0]?.hooks[0]
    if (hook === undefined) throw new Error("a PreToolUse hook must be registered")

    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        session_id: "s",
        transcript_path: "/dev/null",
        cwd: "/data/accounts/sub",
        tool_name: "Bash",
        tool_input: { command: "cat /proc/self/environ" },
        tool_use_id: "toolu_1",
      },
      "toolu_1",
      { signal: AbortSignal.abort() },
    )
    expect(output).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
    })
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

describe("the launch the production invoker actually builds", () => {
  /**
   * Everything above this line asserts a launch a *test* constructed. This asserts the one
   * `createSdkInvoker` builds — the object `composition/index.ts` wires into the dispatcher — with
   * only `query()` and the executable ladder injected, because `bin/test` may never spawn a
   * `claude` CLI. A guarantee that holds in `launchFor()` and not here would be no guarantee at all.
   */
  const CLI: CliResolution = {
    ok: true,
    source: "platform_package",
    path: "/opt/claude/claude",
    bytes: 245_000_000,
  }

  /** Serves one turn through the real transport and hands back the options it launched with. */
  async function launchedOptions(inherited: Record<string, string> = {}): Promise<Options> {
    const captured: Options[] = []
    const restore = new Map<string, string | undefined>()
    for (const [name, value] of Object.entries(inherited)) {
      restore.set(name, process.env[name])
      process.env[name] = value
    }

    try {
      const { app, upstream } = harness({
        accounts: [subscriptionAccount("sub-1", { configDir: "/data/accounts/sub-1" })],
        responses: [],
        invokeSdk: createSdkInvoker({
          concurrency: createSdkConcurrency({ global: 2, perAccount: 1 }),
          resolveCli: () => CLI,
          runQuery: ({ options }) => {
            captured.push(options)
            return sdkQueryStream({
              turns: [
                sdkTurn({
                  blocks: [
                    [
                      { type: "text", text: "" },
                      { type: "text_delta", text: "hi" },
                    ],
                  ],
                }),
              ],
            })
          },
        }),
      })

      const res = await app.request("/v1/messages", post(MESSAGE, bearer()))
      await res.text()
      await settle()

      expect(res.status).toBe(200)
      // The other half of "no host process is spawned": no CLI, and no HTTP fallback either.
      expect(upstream.calls).toHaveLength(0)

      const options = captured[0]
      if (options === undefined) throw new Error("the invoker must have launched a query()")
      return options
    } finally {
      for (const [name, value] of restore) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
  }

  test("names the empty allowlist, the empty base tool set, and every isolation flag", async () => {
    const options = await launchedOptions()

    expect(options.allowedTools).toEqual([...PERMITTED_TOOLS])
    expect(options.tools).toEqual([])
    expect(options.permissionMode).toBe("dontAsk")
    expect(options.settingSources).toEqual([])
    expect(options.strictMcpConfig).toBe(true)
    expect(options.skills).toEqual([])
  })

  test("denies every host-executing built-in through its own canUseTool gate", async () => {
    const options = await launchedOptions()
    const canUseTool = options.canUseTool
    if (canUseTool === undefined) throw new Error("canUseTool must be set on every launch")

    for (const toolName of [...HOST_TOOLS, "SomeFutureBuiltin"]) {
      const result = await canUseTool(toolName, {}, { signal: new AbortController().signal })
      expect(result.behavior).toBe("deny")
    }
  })

  test("runs in this account's own directory, with the router's ANTHROPIC_* stripped for real", async () => {
    const options = await launchedOptions({
      ANTHROPIC_API_KEY: "sk-ant-leaked",
      ANTHROPIC_BASE_URL: "https://router.internal",
      CLAUDE_CODE_OAUTH_TOKEN: "leaked-oauth",
    })
    const env = options.env as Record<string, string>

    expect(options.cwd).toBe("/data/accounts/sub-1")
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/accounts/sub-1")
    expect(Object.keys(env).some((key) => key.toUpperCase().startsWith("ANTHROPIC_"))).toBe(false)
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  })
})

describe("the static SPA mount cannot serve anything outside its web root", () => {
  /**
   * This isn't the Agent SDK, but the same failure mode is: a filesystem mount reachable from an
   * unauthenticated HTTP request, sitting on the same host as `CLAUDE_CONFIG_ROOT` (per-Account
   * OAuth credentials) and the process's own `.env` (`ENCRYPTION_KEY`, `DATABASE_URL`,
   * `ADMIN_PASSWORD`). `routes/spa.ts` is mounted last, at `/`, with no router key and no session —
   * a traversal bug there is a wider hole than anything the Agent SDK's own sandbox guards.
   *
   * The fixture below never touches the real filesystem locations — it stands up its own `web/`
   * (the mount's root) beside sibling directories that play the part of `CLAUDE_CONFIG_ROOT` and
   * the repo root, so a traversal that escapes `web/` lands on a marker this test can see.
   */
  const CONFIG_SECRET = "sk-ant-oauth-token-must-never-be-served-by-the-static-mount"
  const ENV_SECRET = "ENCRYPTION_KEY=must-never-be-served-by-the-static-mount"
  const SHELL_HTML = "<!doctype html><title>router console</title>"
  const ACCOUNT_ID = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"

  let base: string
  let webRoot: string

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "router-spa-traversal-"))
    webRoot = join(base, "web")
    mkdirSync(webRoot)
    writeFileSync(join(webRoot, "index.html"), SHELL_HTML)

    // Sibling to the mount's root, one `..` away — exactly where `CLAUDE_CONFIG_ROOT` and a repo
    // checkout's `.env` sit relative to the bundled `dist/web` in a real deployment (`main.ts`'s
    // `resolveWebRoot`).
    const configRoot = join(base, "claude-config-root", ACCOUNT_ID)
    mkdirSync(configRoot, { recursive: true })
    writeFileSync(join(configRoot, "credentials.json"), CONFIG_SECRET)
    writeFileSync(join(base, ".env"), ENV_SECRET)

    // Fixture sanity: if these two writes ever silently no-op, every assertion below would pass
    // vacuously. Fail loudly here instead.
    expect(readFileSync(join(configRoot, "credentials.json"), "utf8")).toBe(CONFIG_SECRET)
    expect(readFileSync(join(base, ".env"), "utf8")).toBe(ENV_SECRET)
  })

  afterAll(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function app() {
    return createApp({
      logger: createLogger({ level: "error", write: () => {} }),
      probes: {
        database: () => Promise.resolve(true),
        accounts: () => Promise.resolve("ok"),
        claudeCli: () => Promise.resolve("platform_package"),
        shuttingDown: () => false,
      },
      webRoot,
    })
  }

  const TRAVERSAL_PATHS = [
    "/../.env",
    "/../../.env",
    "/../claude-config-root/3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410/credentials.json",
    "/%2e%2e/.env",
    "/%2e%2e/%2e%2e/.env",
    "/%2e%2e/claude-config-root/3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410/credentials.json",
    "/assets/%2e%2e/%2e%2e/.env",
    "/..%2f..%2f.env",
    "/%2e%2e%2f%2e%2e%2f.env",
    "/%252e%252e/.env",
    "/..\\..\\.env",
  ]

  test.each(TRAVERSAL_PATHS)("GET %s never leaks a byte of either secret file", async (path) => {
    const res = await app().request(path)
    const body = await res.text()

    expect(body).not.toContain(CONFIG_SECRET)
    expect(body).not.toContain(ENV_SECRET)
    expect(res.status).not.toBe(500)
    // Every one of these either gets refused outright by the static middleware or falls through
    // to the history-API fallback — a 200 body must be the shell, byte for byte, never a partial
    // or wrong file.
    if (res.status === 200) expect(body).toBe(SHELL_HTML)
  })

  test("a legitimate asset request one directory up is still refused, not a false negative", async () => {
    // Guards against a fixture that would make every case above pass by accident (e.g. an empty
    // `webRoot`, which would 404 no matter what the traversal defence does).
    const res = await app().request("/index.html")
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(SHELL_HTML)
  })
})
