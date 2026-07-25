/**
 * The `mcp__<server>__` prefix, added in exactly one place and removed in exactly one place.
 *
 * A client's tools are offered to the SDK through an in-process MCP server (`passthrough.ts`), and
 * everything reached through an MCP server is namespaced: the client declares `get_weather`, the SDK
 * calls it `mcp__client__get_weather`. The client's parser knows only the name it sent, so every
 * name crossing back out is un-prefixed.
 *
 * **The SDK is inconsistent about which form a given surface carries** — a `PreToolUse` hook and a
 * `content_block_start` do not reliably agree, and the answer has changed between CLI releases
 * (docs/idea/11-anthropic-agent-sdk.md §7). So un-prefixing accepts **both**: it strips the prefix
 * when present and returns the name untouched when it is not, rather than assuming either shape.
 *
 * Only *our* server's prefix is stripped. A name from some other MCP server is not ours to rewrite,
 * and `strictMcpConfig: true` (`options.ts`) means there should be none — the narrower rule is free
 * and stays correct if that ever changes.
 */

/**
 * The in-process MCP server's name, and therefore half of every qualified tool name.
 *
 * A constant rather than something derived per request: the name reaches the model inside the tool
 * catalogue, so a value that varies between two otherwise identical requests changes the system
 * prompt and costs a prompt-cache miss on every turn (§7).
 */
export const PASSTHROUGH_SERVER_NAME = "client"

const PREFIX = `mcp__${PASSTHROUGH_SERVER_NAME}__`

/** The name the SDK will know a client tool by. */
export function qualifyToolName(name: string): string {
  return `${PREFIX}${name}`
}

/**
 * The name the **client** knows a tool by.
 *
 * Exactly one prefix is removed, so a client tool genuinely called `mcp__client__x` round-trips:
 * qualifying it yields two prefixes and this takes one back off.
 */
export function unprefixToolName(name: string): string {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name
}
