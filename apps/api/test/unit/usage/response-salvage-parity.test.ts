import { expect, test } from "bun:test"
import { createResponseSalvage } from "../../../src/services/usage/response-salvage"
import { createResponseSalvage as createFrozenSalvage } from "../../fixtures/response-salvage-v2.41.0"

/**
 * A differential fuzz over the salvage scanner: the current scanner, the scanner frozen at 2.41.0
 * and `JSON.parse` read the same generated documents, and every difference is reported with the
 * seed that produced it and with the input itself.
 */

/** The slot tables the scanner keeps, spelled out here so the fuzz reads them independently. */
const ROOT_SLOTS: readonly string[] = [
  "type",
  "usage",
  "status",
  "incomplete_details",
  "error",
  "code",
]
const PARENTS: Readonly<Record<string, readonly string[]>> = {
  base_resp: ["status_code"],
  message: ["usage"],
  response: ["usage", "status", "incomplete_details", "error"],
}
const CODES: readonly string[] = [
  "insufficient_quota",
  "invalid_request_error",
  "rate_limit_exceeded",
]

/** A key as the document spells it, and the name `JSON.parse` reads it as. */
interface KeySpec {
  readonly text: string
  readonly name: string
}

const ROOT_KEYS: readonly KeySpec[] = [
  { text: '"type"', name: "type" },
  { text: '"usage"', name: "usage" },
  { text: '"status"', name: "status" },
  { text: '"incomplete_details"', name: "incomplete_details" },
  { text: '"error"', name: "error" },
  { text: '"code"', name: "code" },
  { text: '"\\u0074ype"', name: "type" },
  { text: '"\\u0075sage"', name: "usage" },
  { text: '"\\u0073tatus"', name: "status" },
  { text: '"\\u0069ncomplete_details"', name: "incomplete_details" },
  { text: '"\\u0065rror"', name: "error" },
  { text: '"\\u0063ode"', name: "code" },
]
const PARENT_KEYS: readonly KeySpec[] = [
  { text: '"message"', name: "message" },
  { text: '"response"', name: "response" },
  { text: '"base_resp"', name: "base_resp" },
  { text: '"\\u006dessage"', name: "message" },
  { text: '"\\u0072esponse"', name: "response" },
  { text: '"\\u0062ase_resp"', name: "base_resp" },
]
const NOISE_KEYS: readonly KeySpec[] = [
  { text: '"pad"', name: "pad" },
  { text: '"id"', name: "id" },
  { text: '"\\u0070ad"', name: "pad" },
]
const KEYS: readonly KeySpec[] = [...ROOT_KEYS, ...PARENT_KEYS, ...NOISE_KEYS]

const encoder = new TextEncoder()
/** A cap no generated document reaches: every slot it holds is kept. */
const CAP = 4096
/** A cap every document overruns: the budget path, where a slot may be dropped on purpose. */
const TIGHT_CAP = 64
const BASE_SEED = 0x2f6a6b21
const ITERATIONS = 300

interface Salvage {
  push(byte: number): void
  finish(): Record<string, unknown> | null
  readonly retainedBytes: number
}

interface Run {
  readonly rebuilt: Record<string, unknown> | null
  readonly retained: number
  readonly peak: number
}

/** mulberry32: a small deterministic PRNG, so a reported seed reproduces its document exactly. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let mix = state
    mix = Math.imul(mix ^ (mix >>> 15), mix | 1)
    mix ^= mix + Math.imul(mix ^ (mix >>> 7), mix | 61)
    return ((mix ^ (mix >>> 14)) >>> 0) / 4294967296
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right))
    return left.length === right.length && left.every((item, at) => sameValue(item, right[at]))
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left).sort()
    const rightKeys = Object.keys(right).sort()
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key, at) => key === rightKeys[at] && sameValue(left[key], right[key]))
    )
  }
  return false
}

/** The document as `JSON.parse` reads it, projected onto the slots the scanner keeps. */
function project(doc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const slot of ROOT_SLOTS) if (slot in doc) out[slot] = doc[slot]
  for (const [parent, slots] of Object.entries(PARENTS)) {
    const value = doc[parent]
    if (!isObject(value)) continue
    const kept: Record<string, unknown> = {}
    for (const slot of slots) if (slot in value) kept[slot] = value[slot]
    if (Object.keys(kept).length > 0) out[parent] = kept
  }
  return out
}

/** The slot paths a payload holds, with their values. */
function flatten(payload: Record<string, unknown> | null): Map<string, unknown> {
  const out = new Map<string, unknown>()
  if (payload === null) return out
  for (const slot of ROOT_SLOTS) if (slot in payload) out.set(slot, payload[slot])
  for (const [parent, slots] of Object.entries(PARENTS)) {
    const value = payload[parent]
    if (!isObject(value)) continue
    for (const slot of slots) if (slot in value) out.set(`${parent}.${slot}`, value[slot])
  }
  return out
}

/** The bytes the scanner holds when it keeps every slot: the source bytes of each kept value. */
function keptBytes(projection: Record<string, unknown>): number {
  let total = 0
  for (const value of flatten(projection).values()) total += JSON.stringify(value)?.length ?? 0
  return total
}

function run(create: (maximumBytes: number) => Salvage, text: string, cap: number): Run {
  const scanner = create(cap)
  let peak = 0
  for (const byte of encoder.encode(text)) {
    scanner.push(byte)
    peak = Math.max(peak, scanner.retainedBytes)
  }
  return { rebuilt: scanner.finish(), retained: scanner.retainedBytes, peak }
}

function valueFor(name: string, rand: () => number): string {
  switch (name) {
    case "usage":
      return rand() < 0.3
        ? `{"pad":"${"p".repeat(40 + Math.floor(rand() * 50))}"}`
        : `{"input_tokens":${1 + Math.floor(rand() * 100)}}`
    case "status":
      return rand() < 0.5 ? '"completed"' : '"failed"'
    case "incomplete_details":
      return '{"reason":"max_output_tokens"}'
    case "error":
      // A root error is an object in most frames and a plain value in some: the last one decides
      // whether the frame reads as an empty error object.
      return rand() < 0.3
        ? `"${CODES[Math.floor(rand() * CODES.length)] ?? "unknown"}"`
        : `{"code":"${CODES[Math.floor(rand() * CODES.length)] ?? "unknown"}"}`
    case "code":
      return `"${CODES[Math.floor(rand() * CODES.length)] ?? "unknown"}"`
    case "status_code":
      return `${1000 + Math.floor(rand() * 900)}`
    case "type":
      return '"response.completed"'
    default:
      return `"${Math.floor(rand() * 1000)}"`
  }
}

/** A slot key, sometimes spelled in escapes, as a member of a parent may be. */
function childKey(slot: string, rand: () => number): string {
  if (rand() < 0.25)
    return `"\\u${slot.charCodeAt(0).toString(16).padStart(4, "0")}${slot.slice(1)}"`
  return `"${slot}"`
}

function parentValue(parent: string, rand: () => number): string {
  // A parent replaced by a plain value is a case of its own: the members of the earlier copy go.
  if (rand() < 0.15) return '"replaced"'
  const slots = PARENTS[parent] ?? []
  const count = 1 + Math.floor(rand() * Math.min(3, slots.length))
  const members: string[] = []
  for (let index = 0; index < count; index++) {
    const slot = slots[Math.floor(rand() * slots.length)] ?? "usage"
    members.push(`${childKey(slot, rand)}:${valueFor(slot, rand)}`)
  }
  return `{${members.join(",")}}`
}

function valueForKey(key: KeySpec, rand: () => number): string {
  if (Object.hasOwn(PARENTS, key.name)) return parentValue(key.name, rand)
  if (ROOT_SLOTS.includes(key.name)) return valueFor(key.name, rand)
  return `"${Math.floor(rand() * 1000)}"`
}

interface Member {
  readonly key: KeySpec
  readonly value: string
}

function member(rand: () => number, members: readonly Member[]): Member {
  // A repeated key: the last copy wins, as `JSON.parse` reads it.
  if (members.length > 0 && rand() < 0.3) {
    const earlier = members[Math.floor(rand() * members.length)]
    if (earlier) return { key: earlier.key, value: valueForKey(earlier.key, rand) }
  }
  const key = KEYS[Math.floor(rand() * KEYS.length)] ?? { text: '"type"', name: "type" }
  return { key, value: valueForKey(key, rand) }
}

/** A valid JSON document over the slot surface, with repeated keys and escaped ones. */
function document(rand: () => number): string {
  const members: Member[] = []
  const count = 2 + Math.floor(rand() * 5)
  for (let index = 0; index < count; index++) members.push(member(rand, members))
  if (members.length > 0 && rand() < 0.4) {
    const earlier = members[Math.floor(rand() * members.length)]
    if (earlier) members.push({ key: earlier.key, value: valueForKey(earlier.key, rand) })
  }
  return `{${members.map((entry) => `${entry.key.text}:${entry.value}`).join(",")}}`
}

test("the current scanner reads a document as JSON.parse does, over the whole slot surface", () => {
  for (let index = 0; index < ITERATIONS; index++) {
    const seed = (BASE_SEED + index) >>> 0
    const rand = prng(seed)
    const text = document(rand)
    const report = (what: string) => `seed=${seed} input=${text}\n${what}`
    const doc = JSON.parse(text) as Record<string, unknown>
    const projection = project(doc)
    const expected = keptBytes(projection)
    const current = run(createResponseSalvage, text, CAP)
    const frozen = run(createFrozenSalvage, text, CAP)

    // The retained bytes never exceed the cap, after any push.
    if (current.peak > CAP || frozen.peak > CAP)
      throw new Error(report(`retained ${current.peak}/${frozen.peak} bytes over the cap ${CAP}`))

    // Nothing was dropped, so the rebuilt payload is the projection of what `JSON.parse` read.
    if (current.retained !== expected)
      throw new Error(
        report(`current kept ${current.retained} bytes, the projection needs ${expected}`),
      )
    if (!sameValue(current.rebuilt, projection))
      throw new Error(
        report(`current ${JSON.stringify(current.rebuilt)} is not ${JSON.stringify(projection)}`),
      )

    // No key the 2.41.0 scanner kept is lost, unless `JSON.parse` says that value was stale.
    const currentSlots = flatten(current.rebuilt)
    const frozenSlots = flatten(frozen.rebuilt)
    const projectionSlots = flatten(projection)
    for (const [path, value] of frozenSlots) {
      if (currentSlots.has(path)) continue
      const projected = projectionSlots.get(path)
      if (projected !== undefined && sameValue(value, projected))
        throw new Error(report(`current lost ${path}, which 2.41.0 kept and JSON.parse kept too`))
    }
  }
})

test("a tight budget still bounds the retained bytes, and keeps only slots JSON.parse read", () => {
  for (let index = 0; index < ITERATIONS; index++) {
    const seed = (BASE_SEED + index) >>> 0
    const rand = prng(seed)
    const text = document(rand)
    const report = (what: string) => `seed=${seed} input=${text}\n${what}`
    const doc = JSON.parse(text) as Record<string, unknown>
    const projection = project(doc)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    if (current.peak > TIGHT_CAP || frozen.peak > TIGHT_CAP)
      throw new Error(
        report(`retained ${current.peak}/${frozen.peak} bytes over the cap ${TIGHT_CAP}`),
      )
    if (frozen.rebuilt !== null && current.rebuilt === null)
      throw new Error(report("current failed where 2.41.0 succeeded"))
    const currentSlots = flatten(current.rebuilt)
    for (const [path, value] of flatten(frozen.rebuilt)) {
      if (sameValue(value, flatten(projection).get(path)) && !currentSlots.has(path))
        throw new Error(report(`current lost ${path}, which 2.41.0 and JSON.parse kept`))
    }
    // A slot may be dropped on purpose here, but no slot may be one JSON.parse did not read.
    const projected = flatten(projection)
    for (const path of flatten(current.rebuilt).keys()) {
      if (!projected.has(path))
        throw new Error(report(`current kept ${path}, which JSON.parse did not`))
    }
  }
})

test.each([
  `"\\u0075sage":{"pad":"${"p".repeat(65)}"},"status":"completed"`,
  `"\\u0075sage":{"pad":"${"p".repeat(45)}"},"status":"completed"`,
  `"\\u0072esponse":{"usage":{"pad":"${"p".repeat(65)}"}},"status":"completed"`,
  `"response":{"\\u0075sage":{"pad":"${"p".repeat(65)}"}},"status":"completed"`,
])("escaped slots cannot lose a frozen tight-cap success: %s", (members) => {
  const text = `{${members}}`
  expect(run(createFrozenSalvage, text, TIGHT_CAP).rebuilt).toEqual({ status: "completed" })
  expect(run(createResponseSalvage, text, TIGHT_CAP).rebuilt).toMatchObject({ status: "completed" })
})

test.each([
  `"usage":0,"\\u0075sage":{"pad":"${"p".repeat(65)}"},"status":"completed"`,
  `"usage":0,"\\u0075sage":{"pad":"${"p".repeat(45)}"},"status":"completed"`,
])("a mixed-spelling repeat yields at the cap, keeping the frozen success: %s", (members) => {
  const text = `{${members}}`
  // 2.41.0 read the literal `usage` and kept the later `status`; the escaped spelling was no
  // slot to it. The current scanner reads both as the one slot, so the escaped copy replaces the
  // literal one — and gives way at the cap rather than failing the frame.
  expect(run(createFrozenSalvage, text, TIGHT_CAP).rebuilt).toEqual({
    usage: 0,
    status: "completed",
  })
  const current = run(createResponseSalvage, text, TIGHT_CAP).rebuilt
  expect(current).not.toBeNull()
  expect(current).toEqual({ status: "completed" })
})

test("the frozen 2.41.0 scanner still shows the two divergences the current one no longer has", () => {
  // A repeated parent: 2.41.0 kept the child of the copy the later one replaced.
  const repeated = `{"response":{"usage":{"input_tokens":1}},"response":{"status":"x"}}`
  expect(run(createFrozenSalvage, repeated, CAP).rebuilt).toEqual({
    response: { usage: { input_tokens: 1 }, status: "x" },
  })
  expect(run(createResponseSalvage, repeated, CAP).rebuilt).toEqual({ response: { status: "x" } })

  // A later non-object root error: 2.41.0 rebuilt `{}` in place of the value.
  const error = `{"error":{"code":"x"},"error":"boom"}`
  expect(run(createFrozenSalvage, error, CAP).rebuilt).toEqual({ error: {} })
  expect(run(createResponseSalvage, error, CAP).rebuilt).toEqual({ error: "boom" })
})

test("the corpus reaches every shape the two scanners read differently", () => {
  let staleChild = 0
  let placeholder = 0
  let escapedSlot = 0
  for (let index = 0; index < ITERATIONS; index++) {
    const text = document(prng((BASE_SEED + index) >>> 0))
    const current = flatten(run(createResponseSalvage, text, CAP).rebuilt)
    const frozen = flatten(run(createFrozenSalvage, text, CAP).rebuilt)
    // A member 2.41.0 kept under a replaced parent, and one the current scanner matched by decoding.
    if ([...frozen.keys()].some((path) => !current.has(path))) staleChild++
    if ([...current.keys()].some((path) => !frozen.has(path))) escapedSlot++
    // The `{}` 2.41.0 rebuilt in place of a later non-object root error.
    if (frozen.has("error") && sameValue(frozen.get("error"), {})) placeholder++
  }
  expect(staleChild).toBeGreaterThan(0)
  expect(escapedSlot).toBeGreaterThan(0)
  expect(placeholder).toBeGreaterThan(0)
})
