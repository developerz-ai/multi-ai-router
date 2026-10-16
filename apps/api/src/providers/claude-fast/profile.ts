import { arch, platform } from "node:os"
import { CLAUDE_FAST_CLI_VERSION } from "./integrity"

// Provenance: CLI 2.1.301 OAuth TTY captures, 2026-10-16. See docs/research/claude-wire.md.
export const HUMAN_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude."
export const SDK_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK."
export const FAST_URL = "https://api.anthropic.com/v1/messages?beta=true"
export const FAST_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "per-turn-control-2026-07-01",
  "mid-conversation-tool-changes-2026-07-01",
  "mid-conversation-system-clear-at-2026-08-21",
  "effort-2025-11-24",
  "thinking-binding-controls-2026-08-01",
  "extended-cache-ttl-2025-04-11",
  "cache-diagnosis-2026-04-07",
] as const

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
    "X-Stainless-Runtime-Version": "v26.3.0",
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
    "x-client-request-id": crypto.randomUUID(),
  }
}
