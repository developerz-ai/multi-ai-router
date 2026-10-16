import { createHash } from "node:crypto"
import { z } from "zod"

export const CLAUDE_FAST_CLI_VERSION = "2.1.301"
const SEEDS: Readonly<Record<string, bigint>> = { [CLAUDE_FAST_CLI_VERSION]: 0x4d659218e32a3268n }
const record = z.record(z.string(), z.unknown())
const BILLING = "x-anthropic-billing-header:"
const TOKEN = /\bcch=([0-9a-f]{5});/i

// Canonical projection described by askalf/dario at 4b7482a, independently verified
// against 22 current native captures. Never edit a token quoted in conversation content.
export function stampIntegrity(body: Record<string, unknown>, version: string): string {
  const seed = SEEDS[version]
  if (seed === undefined) throw new Error("uncalibrated Claude request profile")
  const blocks = z.array(record).parse(body.system)
  const index = blocks.findIndex(
    (block) =>
      block.type === "text" && typeof block.text === "string" && block.text.startsWith(BILLING),
  )
  const block = blocks[index]
  if (!block || typeof block.text !== "string" || !TOKEN.test(block.text))
    throw new Error("missing Claude request checksum")
  const text = block.text.replace(TOKEN, "cch=00000;")
  const system = blocks.map((entry, at) => (at === index ? { ...entry, text } : entry))
  const projection: Record<string, unknown> = { ...body, system, model: "" }
  delete projection.max_tokens
  delete projection.fallbacks
  delete projection.fallback_credit_token
  const checksum = (Bun.hash.xxHash64(JSON.stringify(projection), seed) & 0xfffffn)
    .toString(16)
    .padStart(5, "0")
  const stamped = system.map((entry, at) =>
    at === index ? { ...entry, text: text.replace(TOKEN, `cch=${checksum};`) } : entry,
  )
  return JSON.stringify({ ...body, system: stamped })
}

export function inspectIntegrity(bodyText: string) {
  const body = record.parse(JSON.parse(bodyText))
  const blocks = z.array(record).parse(body.system)
  const block = blocks.find(
    (entry) => typeof entry.text === "string" && entry.text.startsWith(BILLING),
  )
  const text = typeof block?.text === "string" ? block.text : ""
  const version = /\bcc_version=(\d+\.\d+\.\d+)\.[0-9a-f]{3};/i.exec(text)?.[1]
  const expected = TOKEN.exec(text)?.[1]?.toLowerCase()
  if (!version || !expected) throw new Error("missing Claude request checksum")
  const stamped = record.parse(JSON.parse(stampIntegrity(body, version)))
  const stampedBlocks = z.array(record).parse(stamped.system)
  const actualBlock = stampedBlocks.find(
    (entry) => typeof entry.text === "string" && entry.text.startsWith(BILLING),
  )
  const actual =
    typeof actualBlock?.text === "string" ? TOKEN.exec(actualBlock.text)?.[1] : undefined
  return {
    version,
    expected,
    actual,
    matches: actual === expected,
    bodyBytes: Buffer.byteLength(bodyText),
  }
}

/** The original first non-meta user text, before CLI-injected context. */
export function versionSuffix(firstUserText: string, version: string): string {
  const sample = [4, 7, 20].map((i) => firstUserText[i] || "0").join("")
  return createHash("sha256").update(`59cf53e54c78${sample}${version}`).digest("hex").slice(0, 3)
}

export function stableUuid(namespace: string): string {
  const bytes = createHash("sha256").update(namespace).digest().subarray(0, 16)
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = bytes.toString("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
