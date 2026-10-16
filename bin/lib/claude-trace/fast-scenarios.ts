import { z } from "../../../apps/api/node_modules/zod"
import { readFastCredential } from "../../../apps/api/src/providers/claude-fast/credential"
import { createFastInvoker } from "../../../apps/api/src/providers/claude-fast/invoker"
import { createSdkConcurrency } from "../../../apps/api/src/providers/claude-sdk/concurrency"

// Opt-in operator diagnostic only; production reads under the account metadata-owner fence.
const { configDir, model } = z
  .object({
    configDir: z.string().min(1),
    model: z.string().min(1),
  })
  .parse({ configDir: process.env.CLAUDE_CONFIG_DIR, model: process.env.CLAUDE_TRACE_MODEL })
const messageSchema = z.looseObject({
  content: z.array(z.record(z.string(), z.unknown())),
  usage: z.unknown(),
})
const concurrency = createSdkConcurrency({ global: 2, perAccount: 2 })
let quotaReadings = 0
const invoke = createFastInvoker({
  concurrency,
  credential: () => readFastCredential(configDir),
  resolveModel: (_, requested) => requested,
  errorMaxBytes: 4096,
  sdk: async () => {
    throw new Error("fast trace requires warm credentials and a calibrated request")
  },
})
const messages: Record<string, unknown>[] = [
  {
    role: "user",
    content: `Remember TRACE_42. ${"Synthetic cache context: the marker is TRACE_42. ".repeat(500)} Call trace_echo with that marker.`,
  },
]
const tools = [
  {
    name: "trace_echo",
    description: "Client-side synthetic echo; no external access",
    input_schema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
    },
  },
]
async function turn(stream: boolean) {
  return invoke({
    accountId: "explicit-debug-account",
    configDir,
    apiKeyId: "trace",
    sessionKey: "synthetic-mitm-trace",
    model,
    body: Buffer.from(JSON.stringify({ model, max_tokens: 256, messages, tools, stream })),
    signal: AbortSignal.timeout(90_000),
    session: { kind: "fresh", reason: "no-session" },
    onRateLimit: () => {
      quotaReadings++
    },
  })
}
const first = await turn(false)
if (!first.ok) throw new Error(`fast trace first turn returned HTTP ${first.status}`)
const message = messageSchema.parse(await first.json())
const tool = message.content.find(
  (block: Record<string, unknown>) => block.type === "tool_use" && block.name === "trace_echo",
)
if (!tool || !z.object({ marker: z.literal("TRACE_42") }).safeParse(tool.input).success)
  throw new Error("synthetic tool call missing or incorrect")
messages.push(
  { role: "assistant", content: message.content },
  {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: tool.id, content: "TRACE_42" },
      { type: "text", text: "Reply only TRACE_42; no more tool calls." },
    ],
  },
)
const second = await turn(false)
if (!second.ok) throw new Error(`fast trace tool result returned HTTP ${second.status}`)
const answer = messageSchema.parse(await second.json())
if (
  !answer.content.some(
    (block: Record<string, unknown>) =>
      block.type === "text" && typeof block.text === "string" && block.text.includes("TRACE_42"),
  )
)
  throw new Error("marker lost in tool round trip")
const streamed = await turn(true)
if (!streamed.ok) throw new Error(`fast trace streaming returned HTTP ${streamed.status}`)
const wire = await streamed.text()
if (!wire.includes('"message_stop"')) throw new Error("stream did not complete")
if (concurrency.inFlight !== 0) throw new Error("fast trace leaked concurrency permits")
process.stdout.write(
  `${JSON.stringify({ firstStatus: first.status, secondStatus: second.status, streamingStatus: streamed.status, toolRoundTrip: true, markerPreserved: true, firstUsage: message.usage, secondUsage: answer.usage, quotaReadings })}\n`,
)
