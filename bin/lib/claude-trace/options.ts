import { resolve } from "node:path"
import { subprocessEnv } from "../../../apps/api/src/providers/claude-sdk/env"

export function parse(args: string[]) {
  let configDir: string | undefined
  let model: string | undefined
  let cli = "claude"
  let port: number | undefined
  let privateWire = false
  for (let i = 0; i < args.length; i++) {
    const key = args[i]
    if (key === "--private-wire") {
      privateWire = true
      continue
    }
    const value = args[++i]
    if (!value) throw new Error(`missing value for ${key}`)
    switch (key) {
      case "--config-dir":
        configDir = resolve(value)
        break
      case "--model":
        model = value
        break
      case "--cli":
        cli = value
        break
      case "--port":
        port = Number(value)
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
          throw new Error("invalid --port")
        break
      default:
        throw new Error(`unknown trace option: ${key}`)
    }
  }
  return { configDir, model, cli, port, privateWire }
}

export function availablePort(): number {
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() })
  const port = listener.port
  listener.stop(true)
  if (!port) throw new Error("cannot allocate trace port")
  return port
}
export function traceEnv(
  configDir: string | undefined,
  proxy: string,
  root: string,
): Record<string, string> {
  const env = subprocessEnv({ configDir: configDir ?? "" })
  for (const key of Object.keys(env))
    if (
      key.startsWith("CLAUDE_") ||
      key === "CLAUDECODE" ||
      /^(https?_proxy|all_proxy|no_proxy)$/i.test(key)
    )
      delete env[key]
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir
  return {
    ...env,
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    NO_PROXY: "localhost,127.0.0.1",
    NODE_EXTRA_CA_CERTS: resolve(root, "ca/mitmproxy-ca-cert.pem"),
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  }
}
