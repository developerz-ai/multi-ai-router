import { existsSync } from "node:fs"
import { chmod, mkdir, open, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { cliCommand } from "./cli-command"
import { availablePort, parse, traceEnv } from "./options"

const HELP = `Usage: bin/claude-trace <pty|tty|print|sdk|conversation|subagents|autocompact|fast> [options]
       bin/claude-trace analyze <flows.jsonl>
       bin/claude-trace verify-bodies <private-bodies.jsonl>
       bin/claude-trace <versions|update-sdk>
       bin/claude-trace transport --model MODEL [--cli PATH] [--private-wire]

Live diagnostics, using your Claude login. Never runs as part of CI.
  --config-dir PATH   Selected debug account; required for fast, optional for CLI traces
  --model MODEL       Required for live traces; never silently selects another model
  --private-wire     Also save exact request bodies (private prompts/IDs, never auth headers)
  --cli PATH         Claude executable (default: claude on PATH)
  --port PORT        Loopback proxy port (default: available ephemeral port)
  --prompt-stdin     Read one prompt from stdin (pty only); otherwise uses a synthetic prompt

Requires bun, python3, uv, and claude. Artifacts: tmp/claude-http/runs/<timestamp>-<mode>/
TTY scenarios: normal turn, follow-up, /context, /usage, /compact, echo MCP, arithmetic Agent.
PTY: automated interactive Claude, native system prompt, no -p/SDK, 120s deadline.
Inherited entrypoint overrides are removed; PTY verifies cc_entrypoint=cli on the wire.
Only Agent and the synthetic echo MCP are allowed; no shell/filesystem tools.
See docs/research/claude-wire.md for exact scenarios and interpretation.
`
const MODES = [
  "pty",
  "tty",
  "print",
  "sdk",
  "conversation",
  "subagents",
  "autocompact",
  "fast",
] as const
type Mode = (typeof MODES)[number]

async function main(): Promise<void> {
  const [mode, ...args] = process.argv.slice(2)
  if (!mode || mode === "--help" || mode === "-h") {
    process.stdout.write(HELP)
    return
  }
  if (mode === "versions" || mode === "update-sdk") {
    if (args.length !== 0) throw new Error(`${mode} takes no arguments`)
    const { sdkVersion } = await import("./sdk-version")
    await sdkVersion(mode === "update-sdk")
    return
  }
  if (mode === "transport") {
    const options = parse(args)
    if (!options.model) throw new Error("transport requires --model MODEL")
    if (options.configDir || options.port)
      throw new Error("transport uses only an isolated stub account and available local ports")
    const { transportTrace } = await import("./transport")
    await transportTrace(options.model, options.cli, options.privateWire)
    return
  }
  if (mode === "verify-bodies") {
    if (args.length !== 1 || !args[0])
      throw new Error("verify-bodies requires one private-bodies.jsonl path")
    const { verifyBodies } = await import("./integrity")
    await verifyBodies(args[0])
    return
  }
  if (mode === "analyze") {
    const { analyze } = await import("./summary")
    if (args.length !== 1 || !args[0]) throw new Error("analyze requires one flows.jsonl path")
    await analyze(args[0])
    return
  }
  if (!MODES.includes(mode as Mode)) throw new Error(`unknown trace mode: ${mode}`)
  const options = parse(args)
  if (options.promptStdin && mode !== "pty") throw new Error("--prompt-stdin requires pty mode")
  if (!options.model) throw new Error("live traces require --model MODEL")
  if (mode === "fast" && !options.configDir)
    throw new Error("fast requires an explicitly selected --config-dir")
  if (mode === "tty" && !process.stdin.isTTY) throw new Error("tty mode requires a terminal")
  const prompt = options.promptStdin
    ? await Bun.stdin.text()
    : "Remember marker TRACE_42. Reply with only TRACE_OK."
  if (mode === "pty" && !prompt.trim()) throw new Error("PTY prompt must not be empty")
  for (const binary of ["uv", "python3", options.cli])
    if (!Bun.which(binary)) throw new Error(`missing diagnostic prerequisite: ${binary}`)
  const root = resolve(
    "tmp/claude-http/runs",
    `${new Date().toISOString().replaceAll(":", "-")}-${mode}`,
  )
  await mkdir(resolve(root, "workspace"), { recursive: true, mode: 0o700 })
  await chmod(root, 0o700)
  const port = options.port ?? availablePort()
  const proxy = `http://127.0.0.1:${port}`
  const env = traceEnv(options.configDir, proxy, root)
  const manifest = {
    mode,
    model: options.model,
    privateWire: options.privateWire,
    entrypointOverride: null,
    ...(mode === "pty" ? { input: "interactive-initial-prompt", completion: "Stop-hook" } : {}),
    startedAt: new Date().toISOString(),
    cliVersion: await version([options.cli, "--version"], env),
    sdkVersion: (
      (await Bun.file(
        "apps/api/node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      ).json()) as { version: string }
    ).version,
    proxyVersion: "12.2.3",
  }
  await writeFile(resolve(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  })
  const proxyLog = await open(resolve(root, "proxy.log"), "w", 0o600)
  const proxyEnv = { ...env }
  for (const key of Object.keys(proxyEnv))
    if (/^(https?_proxy|all_proxy|no_proxy|node_extra_ca_certs)$/i.test(key)) delete proxyEnv[key]
  const mitm = Bun.spawn(
    [
      "uv",
      "tool",
      "run",
      "--from",
      "mitmproxy==12.2.3",
      "mitmdump",
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      String(port),
      "--set",
      `confdir=${resolve(root, "ca")}`,
      "--set",
      "flow_detail=0",
      "--set",
      "termlog_verbosity=error",
      "-s",
      resolve(import.meta.dir, "capture.py"),
    ],
    {
      env: {
        ...proxyEnv,
        CLAUDE_TRACE_DIR: root,
        CLAUDE_TRACE_PRIVATE: options.privateWire ? "1" : "0",
      },
      stdout: proxyLog.fd,
      stderr: proxyLog.fd,
    },
  )
  let child: ReturnType<typeof Bun.spawn> | undefined
  const stop = () => {
    child?.kill("SIGTERM")
    mitm.kill("SIGTERM")
  }
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
  process.stderr.write(`Trace artifacts: ${root}\n`)
  try {
    await ready(port, resolve(root, "ca/mitmproxy-ca-cert.pem"), mitm)
    if (mode === "autocompact") env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = "1"
    env.CLAUDE_TRACE_DIR = root
    env.CLAUDE_TRACE_MODEL = options.model
    env.CLAUDE_TRACE_CLI = options.cli
    env.CLAUDE_TRACE_PRIVATE = options.privateWire ? "1" : "0"
    const command =
      mode === "pty"
        ? [
            "python3",
            resolve(import.meta.dir, "interactive-pty.py"),
            "--",
            options.cli,
            "--model",
            options.model,
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--permission-mode",
            "dontAsk",
            "--tools",
            "",
            "--",
            prompt,
          ]
        : mode === "tty" || mode === "print"
          ? await cliCommand(mode, options.cli, options.model, root)
          : [
              "bun",
              resolve(import.meta.dir, mode === "fast" ? "fast-scenarios.ts" : "sdk-scenarios.ts"),
              mode,
            ]
    child = Bun.spawn(command, {
      cwd: resolve(root, "workspace"),
      env,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    const code = await child.exited
    await Bun.sleep(150) // Let the proxy's final response hook flush before shutdown.
    if (code !== 0) throw new Error(`Claude trace exited ${code}; inspect local artifacts`)
    if (mode === "pty") {
      const { verifyInteractiveCapture } = await import("./summary")
      const count = verifyInteractiveCapture(await Bun.file(resolve(root, "flows.jsonl")).text())
      process.stderr.write(`Verified ${count} interactive Messages request(s): cc_entrypoint=cli\n`)
    }
  } finally {
    stop()
    await mitm.exited
    process.removeListener("SIGINT", stop)
    process.removeListener("SIGTERM", stop)
    await proxyLog.close()
  }
}

async function version(command: string[], env: Record<string, string>): Promise<string> {
  const child = Bun.spawn(command, { env, stdout: "pipe", stderr: "ignore" })
  const text = await new Response(child.stdout).text()
  if ((await child.exited) !== 0) throw new Error("cannot read Claude version")
  return text.trim()
}
async function ready(
  port: number,
  ca: string,
  process: ReturnType<typeof Bun.spawn>,
): Promise<void> {
  for (let i = 0; i < 1200; i++) {
    if (process.exitCode !== null) throw new Error("MITM proxy exited; inspect proxy.log")
    if (existsSync(ca)) {
      try {
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port,
          socket: {
            data() {},
            open(socket) {
              socket.end()
            },
          },
        })
        socket.end()
        return
      } catch {
        /* Wait for the proxy to bind. */
      }
    }
    await Bun.sleep(50)
  }
  throw new Error("MITM proxy did not become ready within 60 seconds")
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "trace failed"}\n`)
  process.exitCode = 1
})
