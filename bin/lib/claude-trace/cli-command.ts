import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

export async function cliCommand(
  mode: "tty" | "print",
  cli: string,
  model: string,
  root: string,
): Promise<string[]> {
  const mcp = resolve(root, "mcp.json")
  await writeFile(
    mcp,
    JSON.stringify({
      mcpServers: {
        trace: {
          command: "bun",
          args: [resolve(import.meta.dir, "mcp.ts")],
        },
      },
    }),
    { mode: 0o600 },
  )
  const args = [
    cli,
    "--model",
    model,
    "--setting-sources",
    "",
    "--settings",
    '{"disableAllHooks":true}',
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--system-prompt",
    "You are a helpful assistant for a synthetic HTTP trace. Answer briefly.",
  ]
  if (mode === "print")
    return [
      ...args,
      "--tools",
      "",
      "--mcp-config",
      '{"mcpServers":{}}',
      "-p",
      "Remember marker TRACE_42. Reply with only TRACE_OK.",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--no-session-persistence",
    ]
  return [
    ...args,
    "--tools",
    "Agent",
    "--allowedTools",
    "Agent",
    "mcp__trace__echo_marker",
    "--mcp-config",
    mcp,
    "--agents",
    JSON.stringify({
      trace_worker: {
        description: "Synthetic arithmetic worker with no tools",
        prompt: "Compute arithmetic. No tools.",
        tools: [],
        model,
        maxTurns: 1,
      },
    }),
  ]
}
