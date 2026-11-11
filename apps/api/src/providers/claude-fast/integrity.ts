import { createHash } from "node:crypto"
import { z } from "zod"

export const CLAUDE_FAST_CLI_VERSION = "2.1.319"
// The seed is per observed CLI build, not per release. 2.1.319 reuses the 2.1.301 seed:
// 15/15 private print/sdk/conversation/subagent/autocompact captures matched on 2026-11-07.
const SEEDS: Readonly<Record<string, bigint>> = {
  "2.1.301": 0x4d659218e32a3268n,
  [CLAUDE_FAST_CLI_VERSION]: 0x4d659218e32a3268n,
}
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
  // The projection and the final body differ only in `system`, `model` and the dropped keys, so
  // every other top-level value is serialised once and the two documents are assembled around it
  // (101 finding 05.6). The byte layout is exactly `JSON.stringify` of
  // `{ ...body, system, model: "" }` minus the dropped keys, and of `{ ...body, system: stamped }`.
  const parts = new Map<string, string>()
  for (const [key, value] of Object.entries(body)) {
    if (key === "system") continue
    const json = JSON.stringify(value)
    if (json !== undefined) parts.set(key, json)
  }
  const assemble = (systemJson: string, projection: boolean): string => {
    const members: string[] = []
    const emit = (key: string, json: string) => members.push(`${JSON.stringify(key)}:${json}`)
    for (const key of Object.keys(body)) {
      if (key === "system") emit(key, systemJson)
      else if (projection && key === "model") emit(key, '""')
      else if (projection && PROJECTION_DROPS.has(key)) continue
      else {
        const json = parts.get(key)
        if (json !== undefined) emit(key, json)
      }
    }
    if (!Object.hasOwn(body, "system")) emit("system", systemJson)
    if (projection && !Object.hasOwn(body, "model")) emit("model", '""')
    return `{${members.join(",")}}`
  }
  const checksum = (Bun.hash.xxHash64(assemble(JSON.stringify(system), true), seed) & 0xfffffn)
    .toString(16)
    .padStart(5, "0")
  const stamped = system.map((entry, at) =>
    at === index ? { ...entry, text: text.replace(TOKEN, `cch=${checksum};`) } : entry,
  )
  return assemble(JSON.stringify(stamped), false)
}

/** Keys the checksum projection leaves out. */
const PROJECTION_DROPS: ReadonlySet<string> = new Set([
  "max_tokens",
  "fallbacks",
  "fallback_credit_token",
])

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
