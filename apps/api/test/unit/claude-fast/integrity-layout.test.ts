import { describe, expect, test } from "bun:test"
import {
  CLAUDE_FAST_CLI_VERSION,
  stampIntegrity,
} from "../../../src/providers/claude-fast/integrity"

/**
 * 101 finding 05.6: `stampIntegrity` now serialises the history once and assembles the checksum
 * projection and the final body around it. The private 22/22 + 15/15 captures are not in the repo,
 * so the oracle here is the previous two-`JSON.stringify` implementation, kept verbatim below: the
 * new output must be byte-identical to it for every body shape.
 */

const SEED = 0x4d659218e32a3268n
const TOKEN = /\bcch=([0-9a-f]{5});/i
const BILLING = "x-anthropic-billing-header:"

function reference(body: Record<string, unknown>): string {
  const blocks = body.system as Record<string, unknown>[]
  const index = blocks.findIndex(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.startsWith(BILLING),
  )
  const block = blocks[index] as { text: string }
  const text = block.text.replace(TOKEN, "cch=00000;")
  const system = blocks.map((entry, at) => (at === index ? { ...entry, text } : entry))
  const projection: Record<string, unknown> = { ...body, system, model: "" }
  delete projection.max_tokens
  delete projection.fallbacks
  delete projection.fallback_credit_token
  const checksum = (Bun.hash.xxHash64(JSON.stringify(projection), SEED) & 0xfffffn)
    .toString(16)
    .padStart(5, "0")
  const stamped = system.map((entry, at) =>
    at === index ? { ...entry, text: text.replace(TOKEN, `cch=${checksum};`) } : entry,
  )
  return JSON.stringify({ ...body, system: stamped })
}

const billing = `${BILLING} cc_version=${CLAUDE_FAST_CLI_VERSION}.abc; cc_entrypoint=cli; cch=00000;`

const bodies: Record<string, unknown>[] = [
  {
    model: "claude-opus-5-5",
    messages: [{ role: "user", content: 'hi   "quoted" \\ </script>' }],
    system: [
      { type: "text", text: billing },
      { type: "text", text: "identity" },
    ],
    tools: [],
    metadata: { user_id: '{"a":1}' },
    max_tokens: 64,
    stream: true,
  },
  {
    system: [
      { type: "text", text: "first" },
      { type: "text", text: billing, cache_control: { type: "ephemeral" } },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    model: "claude-sonnet-5-5",
    fallbacks: "default",
    fallback_credit_token: "t",
    output_config: { format: { type: "json_schema", schema: { type: "object" } } },
    thinking: undefined,
    max_tokens: 1,
    temperature: 0.5,
  },
  {
    // No `model`: the projection appends it last, after `system`.
    messages: [{ role: "user", content: "no model" }],
    system: [{ type: "text", text: billing }],
    max_tokens: 9,
    __proto__: { inherited: true },
  },
  JSON.parse(
    `{"model":"m","__proto__":{"x":1},"system":[{"type":"text","text":${JSON.stringify(billing)}}],"messages":[{"role":"user","content":"own __proto__ key"}],"max_tokens":2}`,
  ),
]

describe("single-pass integrity stamping is byte-identical to the two-pass original", () => {
  for (const [i, body] of bodies.entries()) {
    test(`body ${i}`, () => {
      expect(stampIntegrity(body, CLAUDE_FAST_CLI_VERSION)).toBe(reference(body))
    })
  }
})
