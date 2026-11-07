import { arch, platform } from "node:os"
import { CLAUDE_FAST_CLI_VERSION } from "./integrity"

// Provenance: CLI 2.1.319 OAuth captures, 2026-11-07. See docs/research/claude-wire.md.
export const HUMAN_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const FAST_URL = "https://api.anthropic.com/v1/messages?beta=true"
export const FAST_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "tool-provenance-2026-10-26",
  "thinking-token-count-2026-05-13",
  "mid-conversation-system-clear-at-2026-08-21",
  "effort-2025-11-24",
  "thinking-binding-controls-2026-08-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
] as const

/**
 * Built-in tools the CLI orders after client tools in `x-claude-code-sandy-plover`.
 * The order is telemetry, not a gate; unknown names are treated as client tools.
 */
const BUILTIN_TOOL_NAMES = new Set([
  "Agent",
  "Bash",
  "BashOutput",
  "Edit",
  "Glob",
  "Grep",
  "KillShell",
  "NotebookEdit",
  "Read",
  "Task",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
])
const TOOL_HEADER_MAX_ENTRIES = 64
const TOOL_HEADER_MAX_BYTES = 7168
const TOOL_HEADER_NAME_BYTES = 256
const TOOL_HEADER_TRUNCATED = "unreadable-tools-used-before-summary"

/**
 * Builds the native `x-claude-code-sandy-plover` value: a JSON array of descriptors for the
 * tools already used in the history, client tools first, capped like the CLI. It is empty for a
 * first turn and reflects `tool_use` blocks, not the available tool schema.
 */
export function toolUsageHeader(names: readonly string[]): string {
  const unique = [...new Set(names)].filter(
    (name) => name !== "" && Buffer.byteLength(name, "utf8") <= TOOL_HEADER_NAME_BYTES,
  )
  const ordered = [
    ...unique.filter((name) => !BUILTIN_TOOL_NAMES.has(name)),
    ...unique.filter((name) => BUILTIN_TOOL_NAMES.has(name)),
  ]
  const cap = (values: readonly string[]): string[] => {
    const entries: string[] = []
    let bytes = 0
    for (const name of values) {
      if (entries.length === TOOL_HEADER_MAX_ENTRIES) break
      const entry = JSON.stringify({ name })
      const size = Buffer.byteLength(entry, "utf8") + (entries.length === 0 ? 0 : 1)
      if (bytes + size > TOOL_HEADER_MAX_BYTES) break
      entries.push(entry)
      bytes += size
    }
    return entries
  }
  const entries = cap(ordered)
  const value = entries.length < ordered.length ? cap([TOOL_HEADER_TRUNCATED, ...ordered]) : entries
  return `[${value.join(",")}]`
}

/** Preserve original header case. Bun generates framing headers in the observed native order. */
export function fastHeaders(input: {
  accessToken: string
  sessionId: string
  promptId?: string
  betas?: string | null
  contextTag: boolean
  requestClass?: string | null
  subagent?: boolean
  agentType?: string | null
  toolNames?: readonly string[]
}): Record<string, string> {
  const beta = new Set<string>(FAST_BETAS)
  for (const value of input.betas?.split(",") ?? []) if (value.trim()) beta.add(value.trim())
  if (input.contextTag) beta.add("context-1m-2025-08-07")
  return {
    Accept: "application/json",
    Authorization: `Bearer ${input.accessToken}`,
    "Content-Type": "application/json",
    "User-Agent": `claude-cli/${CLAUDE_FAST_CLI_VERSION} (external, cli)`,
    "X-Claude-Code-Session-Id": input.sessionId,
    "X-Stainless-Arch": arch(),
    "X-Stainless-Lang": "js",
    "X-Stainless-OS":
      platform() === "darwin" ? "MacOS" : platform() === "win32" ? "Windows" : "Linux",
    "X-Stainless-Package-Version": "0.128.0",
    "X-Stainless-Retry-Count": "0",
    "X-Stainless-Runtime": "node",
    "X-Stainless-Runtime-Version": "v26.12.1",
    "X-Stainless-Timeout": "600",
    "anthropic-beta": [...beta].join(","),
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": "2023-06-01",
    "x-app": "cli",
    ...(input.promptId ? { "x-claude-code-prompt-id": input.promptId } : {}),
    "x-claude-code-request-class":
      input.requestClass &&
      ["main", "subagent", "workflow", "compaction", "auxiliary", "side_reply"].includes(
        input.requestClass,
      )
        ? input.requestClass
        : input.subagent
          ? "subagent"
          : input.promptId
            ? "main"
            : "auxiliary",
    ...(input.subagent && input.agentType && /^[A-Za-z0-9_-]{1,64}$/.test(input.agentType)
      ? { "x-claude-code-agent-type": input.agentType }
      : {}),
    // Native order: session id early, tool provenance after the request class, then the
    // client request id. The collector records this relative order.
    "X-Claude-Code-Sandy-Plover": toolUsageHeader(input.toolNames ?? []),
    "x-client-request-id": crypto.randomUUID(),
  }
}
