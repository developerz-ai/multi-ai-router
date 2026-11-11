import { prepareFastRequest, readFastRequest } from "../src/providers/claude-fast/request"
import { sampleQuantile } from "./quantiles"

/**
 * The fast transport's synchronous body work, measured (101 finding 05.6).
 *
 * Fast mode is the default Claude-subscription path, and everything `readFastRequest` and
 * `prepareFastRequest` do runs on the event loop before the upstream call: every other in-flight
 * stream waits for it. Long Claude Code histories are the normal shape, so this leg drives both
 * functions over synthetic conversations of the sizes the finding measured (≈850 KB / 302 messages
 * and ≈3 MB / 602 messages), plus a small one, and reports p50 / p95 / p99 in milliseconds per
 * request. No network, no router, no credential: the identity is a fixed placeholder.
 *
 *   bun apps/api/bench/claude-fast.ts               # defaults
 *   bun apps/api/bench/claude-fast.ts --iterations 200 --json
 */

const IDENTITY = {
  accessToken: "bench-placeholder",
  expiresAt: Number.MAX_SAFE_INTEGER,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}

interface Shape {
  readonly name: string
  readonly messages: number
  /** Characters of text per message; tool turns carry the same in their input and result. */
  readonly textChars: number
}

const SHAPES: readonly Shape[] = [
  { name: "small", messages: 4, textChars: 256 },
  { name: "850KB", messages: 302, textChars: 2_700 },
  { name: "3MB", messages: 602, textChars: 5_000 },
]

/** A Claude Code-shaped history: prompt, then alternating tool_use / tool_result turns. */
function conversation(shape: Shape): Uint8Array {
  const text = "x".repeat(shape.textChars)
  const messages: Record<string, unknown>[] = [{ role: "user", content: `first prompt ${text}` }]
  for (let i = 1; i < shape.messages; i++) {
    const id = `toolu_${i}`
    messages.push(
      i % 2 === 1
        ? {
            role: "assistant",
            content: [
              { type: "text", text },
              { type: "tool_use", id, name: "read_file", input: { path: `/src/${i}.ts` } },
            ],
          }
        : {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: `toolu_${i - 1}`, content: text }],
          },
    )
  }
  if (messages.length % 2 === 0) messages.push({ role: "user", content: "continue" })
  const tools = Array.from({ length: 20 }, (_, i) => ({
    name: `tool_${i}`,
    description: "a tool",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  }))
  const body = {
    model: "claude-opus-5-5",
    max_tokens: 32_000,
    stream: true,
    system: [{ type: "text", text: "You are a coding agent." }],
    tools,
    messages,
  }
  return new TextEncoder().encode(JSON.stringify(body))
}

function measure(bytes: Uint8Array, iterations: number) {
  const read: number[] = []
  const prepare: number[] = []
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now()
    const request = readFastRequest(bytes)
    const t1 = performance.now()
    const prepared = prepareFastRequest({
      request,
      model: "claude-opus-5-5",
      identity: IDENTITY,
      accountId: "account",
      apiKeyId: "key",
      sessionKey: "session",
    })
    const t2 = performance.now()
    if (prepared === null) throw new Error("bench body was refused by the calibrated profile")
    read.push(t1 - t0)
    prepare.push(t2 - t1)
  }
  const total = read.map((value, i) => value + (prepare[i] ?? 0))
  const q = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b)
    return {
      p50: sampleQuantile(sorted, 0.5),
      p95: sampleQuantile(sorted, 0.95),
      p99: sampleQuantile(sorted, 0.99),
    }
  }
  return { read: q(read), prepare: q(prepare), total: q(total) }
}

function main(): void {
  const args = process.argv.slice(2)
  const at = args.indexOf("--iterations")
  const iterations = at >= 0 ? Number(args[at + 1]) : 100
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error("--iterations N, N ≥ 1")
  const rows = SHAPES.map((shape) => {
    const bytes = conversation(shape)
    measure(bytes, Math.min(10, iterations)) // warm the JIT on this shape
    return { shape: shape.name, bytes: bytes.byteLength, ...measure(bytes, iterations) }
  })
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
    return
  }
  const ms = (value: number) => value.toFixed(2).padStart(7)
  process.stdout.write("shape     bytes      read p50  prep p50  total p50  total p95  total p99\n")
  for (const row of rows)
    process.stdout.write(
      `${row.shape.padEnd(8)} ${String(row.bytes).padStart(8)} ${ms(row.read.p50)}   ${ms(row.prepare.p50)}   ${ms(row.total.p50)}    ${ms(row.total.p95)}    ${ms(row.total.p99)}\n`,
    )
}

main()
