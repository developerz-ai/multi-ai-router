import { appendFile } from "node:fs/promises"
import { resolve } from "node:path"
import {
  query,
  type SDKUserMessage,
} from "../../../apps/api/node_modules/@anthropic-ai/claude-agent-sdk"

const mode = process.argv[2]
const root = process.env.CLAUDE_TRACE_DIR
const model = process.env.CLAUDE_TRACE_MODEL
const cli = process.env.CLAUDE_TRACE_CLI
if (!root || !model || !cli) throw new Error("run SDK trace scenarios through bin/claude-trace")
const subagents = mode === "subagents"
const prompts = subagents
  ? [
      "Use the Agent tool to delegate to trace_worker: compute 19 + 23. Actually invoke Agent, then report the result.",
    ]
  : mode === "autocompact"
    ? [
        `Remember marker TRACE_42 and reply briefly.\n${"Synthetic trace context. ".repeat(2500)}`,
        ...Array.from(
          { length: 4 },
          (_, i) => `Trace turn ${i + 2}: reply with only the remembered marker.`,
        ),
      ]
    : mode === "sdk"
      ? ["Remember marker TRACE_42. Reply with only TRACE_OK."]
      : [
          "Remember marker TRACE_42. Reply briefly.",
          "Reply with only the remembered marker.",
          "/compact Keep marker TRACE_42.",
          "After compaction, reply with only the remembered marker.",
        ]
let advance = () => {}
async function* input(): AsyncGenerator<SDKUserMessage> {
  for (const prompt of prompts) {
    const done = new Promise<void>((resolve) => {
      advance = resolve
    })
    yield {
      type: "user",
      message: { role: "user", content: prompt },
      parent_tool_use_id: null,
      session_id: "",
    }
    await done
  }
}
const controller = new AbortController()
const abort = () => controller.abort()
process.once("SIGINT", abort)
process.once("SIGTERM", abort)
const timer = setTimeout(() => controller.abort(), 180_000)
const run = query({
  prompt: input(),
  options: {
    model,
    cwd: resolve(root, "workspace"),
    env: { ...process.env },
    pathToClaudeCodeExecutable: Bun.which(cli) ?? cli,
    abortController: controller,
    tools: subagents ? ["Agent"] : [],
    allowedTools: [],
    settingSources: [],
    settings: { disableAllHooks: true },
    strictMcpConfig: true,
    mcpServers: {},
    permissionMode: "dontAsk",
    canUseTool: async (name, originalInput) =>
      name === "Agent" && subagents
        ? { behavior: "allow", updatedInput: originalInput }
        : { behavior: "deny", message: "No host tools in a wire trace" },
    systemPrompt: "You are a helpful assistant for a synthetic HTTP trace. Answer briefly.",
    maxTurns: 8,
    persistSession: mode !== "sdk",
    includePartialMessages: true,
    ...(subagents
      ? {
          agents: {
            trace_worker: {
              description: "Synthetic arithmetic worker",
              prompt: "Compute arithmetic. No tools.",
              tools: [],
              model,
              maxTurns: 1,
            },
          },
        }
      : {}),
  },
})
let results = 0
let compactions = 0
let delegated = false
try {
  for await (const message of run) {
    if (message.type !== "result" && message.type !== "system") continue
    if (message.type === "system") {
      if (message.subtype === "compact_boundary") compactions++
      if (message.subtype === "task_started") delegated = true
    }
    const event =
      message.type === "result"
        ? {
            type: message.type,
            subtype: message.subtype,
            usage: message.usage,
            is_error: message.is_error,
            resultChars: "result" in message ? message.result.length : undefined,
          }
        : {
            type: message.type,
            subtype: message.subtype,
            ...("status" in message ? { status: message.status } : {}),
            ...("compact_metadata" in message
              ? { compact_metadata: message.compact_metadata }
              : {}),
          }
    await appendFile(resolve(root, "sdk-events.jsonl"), `${JSON.stringify(event)}\n`, {
      mode: 0o600,
    })
    if (message.type === "result") {
      process.stdout.write(`${JSON.stringify(event)}\n`)
      results++
      advance()
      if (message.is_error) throw new Error(`SDK scenario failed: ${message.subtype}`)
    }
  }
  if ((mode === "conversation" || mode === "autocompact") && compactions === 0)
    throw new Error("scenario produced no successful compaction boundary")
  if (subagents && !delegated) throw new Error("scenario did not actually start a subagent")
  if (results !== prompts.length)
    throw new Error(`scenario ended after ${results}/${prompts.length} results`)
} finally {
  clearTimeout(timer)
  run.close()
  process.removeListener("SIGINT", abort)
  process.removeListener("SIGTERM", abort)
}
