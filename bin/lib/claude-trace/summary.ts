import { readFile } from "node:fs/promises"
import { z } from "../../../apps/api/node_modules/zod"

const object = z.record(z.string(), z.unknown())
const flowSchema = z.object({
  method: z.string(),
  path: z.string(),
  status: z.number().optional(),
  http_version: z.string().optional(),
  headers: z.record(z.string(), z.string()),
  response_headers: z.record(z.string(), z.string()).optional(),
  body: object.nullish(),
  events: z.array(object).optional(),
  headers_after_ms: z.number().optional(),
  first_chunk_after_ms: z.number().optional(),
  total_ms: z.number().optional(),
  chunks: z.number().optional(),
  capture_truncated: z.boolean().optional(),
  transport_error: z.boolean().optional(),
})

export function summarizeFlow(value: unknown) {
  const flow = flowSchema.parse(value)
  const body = flow.body ?? {}
  const system = Array.isArray(body.system) ? body.system : []
  const messages = Array.isArray(body.messages) ? body.messages : []
  const blocks: Record<string, number> = {}
  const cacheControls: { location: string; control: unknown }[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((v, i) => {
        walk(v, `${path}[${i}]`)
      })
      return
    }
    const parsed = object.safeParse(value)
    if (!parsed.success) return
    const data = parsed.data
    if (typeof data.type === "string") blocks[data.type] = (blocks[data.type] ?? 0) + 1
    if (data.cache_control) cacheControls.push({ location: path, control: data.cache_control })
    for (const [key, nested] of Object.entries(data))
      if (key !== "cache_control") walk(nested, `${path}.${key}`)
  }
  walk(body, "body")
  const first = object.safeParse(system[0])
  const attribution =
    first.success &&
    typeof first.data.text === "string" &&
    first.data.text.startsWith("x-anthropic-billing-header:")
      ? first.data.text
      : null
  const eventTypes: Record<string, number> = {}
  const usage: unknown[] = []
  for (const event of flow.events ?? []) {
    const type = typeof event.type === "string" ? event.type : "unknown"
    eventTypes[type] = (eventTypes[type] ?? 0) + 1
    const message = object.safeParse(event.message)
    if (message.success && message.data.usage) usage.push(message.data.usage)
    if (event.usage) usage.push(event.usage)
  }
  return {
    method: flow.method,
    path: flow.path,
    status: flow.status,
    transportError: flow.transport_error,
    httpVersion: flow.http_version,
    userAgent: flow.headers["user-agent"],
    attribution,
    session: flow.headers["x-claude-code-session-id"],
    betas: (flow.headers["anthropic-beta"] ?? "").split(",").filter(Boolean),
    model: body.model,
    envelopeFields: Object.keys(body),
    messages: messages.length,
    roles: messages.map((message) => object.safeParse(message).data?.role),
    metadata: body.metadata,
    thinking: body.thinking,
    outputConfig: body.output_config,
    contextManagement: body.context_management,
    cacheControls,
    blocks,
    eventTypes,
    usage,
    quota: Object.fromEntries(
      Object.entries(flow.response_headers ?? {}).filter(
        ([key]) => key.startsWith("anthropic-ratelimit-") || key === "retry-after",
      ),
    ),
    timing: {
      headersMs: flow.headers_after_ms,
      firstChunkMs: flow.first_chunk_after_ms,
      totalMs: flow.total_ms,
      chunks: flow.chunks,
    },
    captureTruncated: flow.capture_truncated,
  }
}

export async function analyze(path: string): Promise<void> {
  const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
  for (let i = 0; i < lines.length; i++) {
    try {
      process.stdout.write(
        `${JSON.stringify({ index: i, ...summarizeFlow(JSON.parse(lines[i] ?? "")) })}\n`,
      )
    } catch {
      // Don't include the invalid line in an error: private captures can contain prompts.
      throw new Error(`invalid flow at line ${i + 1}`)
    }
  }
}
