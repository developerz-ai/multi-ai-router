import { expect, test } from "bun:test"
import { createResponseSalvage } from "../../../src/services/usage/response-salvage"
import { createSlotCanonicalizer } from "../../../src/services/usage/response-salvage-canonical"
import {
  compactSlotEncoding,
  semanticFingerprint,
} from "../../../src/services/usage/response-salvage-slots"
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

test.each([
  '{"usage":{"input_tokens":1.5,"output_tokens":20}}',
  '{"usage":{"input_tokens":1.203,"output_tokens":2.304e10,"other":20}}',
  '{"usage":[1.05e20,1.02e-10,20,3.004,10]}',
])("numeric tokens retain independent fraction and exponent state: %s", (text) => {
  expect(run(createResponseSalvage, text, 4096).rebuilt).toEqual(JSON.parse(text))
})

test("a rejected output byte stops deferred-digit emission permanently", () => {
  let attempts = 0
  const canonical = createSlotCanonicalizer(() => ++attempts <= 64)
  for (const byte of new TextEncoder().encode(`0.${"0".repeat(1_000_000)}1`)) canonical.push(byte)
  canonical.end()
  canonical.push(49)
  expect(attempts).toBe(65)
})

test.each(["usage", "\\u0075sage", "code", "base_resp"])(
  "deferred digits cannot overrun the capture budget: %s",
  (key) => {
    const number = `0.${"0".repeat(1_000_000)}1`
    const value = key === "base_resp" ? `{"status_code":${number}}` : number
    const current = run(createResponseSalvage, `{"${key}":${value}}`, 64)
    expect(current.peak).toBeLessThanOrEqual(64)
  },
)

test.each(["usage", "\\u0075sage", "code", "base_resp.status_code"])(
  "end-only output respects the budget for %s",
  (path) => {
    const cap = path === "code" ? 4 : path === "base_resp.status_code" ? 32 : 64
    const value = `${"1".repeat(cap)}.`
    const text =
      path === "base_resp.status_code"
        ? `{"base_resp":{"status_code":${value}}}`
        : `{"${path}":${value}}`
    const current = run(createResponseSalvage, text, path === "code" ? 16 : cap)
    expect(current.peak).toBeLessThanOrEqual(cap)
    expect(current.rebuilt).toEqual(path === "usage" ? null : {})
  },
)

test("a full budget charges canonical bytes, not redundant fraction digits", () => {
  const text = `{"usage":1,"status":"${"s".repeat(61)}","\\u0075sage":1.0}`
  const frozen = run(createFrozenSalvage, text, 64)
  expect(frozen.rebuilt).toEqual(JSON.parse(text))
  expect(run(createResponseSalvage, text, 64).rebuilt).toEqual(frozen.rebuilt)
})

const encoder = new TextEncoder()
/** A cap no generated document reaches: every slot it holds is kept. */
const CAP = 4096
/** A cap every document overruns: the budget path, where a slot may be dropped on purpose. */
const TIGHT_CAP = 64
const BASE_SEED = 0x2f6a6b21
const ITERATIONS = 300
/** Every third document is the planted budget shape, so the corpus reaches it every time. */
const PLANTED_EVERY = 3

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

/** The canonical form of a value, as the scanner writes it while the value is read. */
function canonicalize(text: string): string {
  const out: number[] = []
  const canonical = createSlotCanonicalizer((byte) => {
    out.push(byte)
    return true
  })
  for (const byte of encoder.encode(text)) canonical.push(byte)
  canonical.end()
  return new TextDecoder().decode(Uint8Array.from(out))
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

function assertRetainedValues(
  rebuilt: Record<string, unknown> | null,
  projection: Record<string, unknown>,
  report: (what: string) => string,
): void {
  const projected = flatten(projection)
  for (const [path, value] of flatten(rebuilt)) {
    // Only a dropped root error object deliberately rebuilds as an empty placeholder.
    const placeholder = path === "error" && isObject(projected.get(path)) && sameValue(value, {})
    if (!projected.has(path) || (!placeholder && !sameValue(value, projected.get(path))))
      throw new Error(report(`current kept ${path}=${JSON.stringify(value)}, unlike JSON.parse`))
  }
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
      // A small literal usage, and a padded object that crowds the budget: the two together are
      // the shape in which a later `code` had no room.
      if (rand() < 0.2) return "0"
      return rand() < 0.35
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
      // A short code fits the optional share at the tight cap; a long one never does — in this
      // scanner and in the frozen one alike, so only the short one tells the two apart.
      return rand() < 0.4
        ? `"${Math.floor(rand() * 100_000_000)}"`
        : `"${CODES[Math.floor(rand() * CODES.length)] ?? "unknown"}"`
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

/** The spellings of one name: the literal one and the escaped one. */
function spellingsOf(name: string): readonly KeySpec[] {
  return KEYS.filter((key) => key.name === name)
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
    if (earlier) {
      // The repeat is spelled the other way half the time: 2.41.0 read the two spellings as two
      // members, the current scanner reads them as the one slot.
      const others = spellingsOf(earlier.key.name).filter((key) => key.text !== earlier.key.text)
      const other = others[Math.floor(rand() * others.length)]
      const key = other !== undefined && rand() < 0.5 ? other : earlier.key
      return { key, value: valueForKey(key, rand) }
    }
  }
  const key = KEYS[Math.floor(rand() * KEYS.length)] ?? { text: '"type"', name: "type" }
  return { key, value: valueForKey(key, rand) }
}

/**
 * The shape that lost a later `code` at the cap: a root slot spelled both ways — the literal
 * first, the escaped copy after it, so the escaped copy replaces it — the escaped copy padded
 * until it fills the budget, and a short `code` behind it. The random corpus reached that shape
 * by luck alone, so it is planted: the escaped copy yields before the `code` is dropped, or the
 * `code` is lost and 2.41.0 kept it (#209: no lost non-stale key).
 */
function plantedBudgetShape(rand: () => number): string {
  // 45..54 padding characters: the escaped copy is 55..64 bytes, so it fills the 64-byte cap
  // and leaves the `code` behind it no room.
  const pad = "p".repeat(45 + Math.floor(rand() * 10))
  // A code inside the optional share (a quarter of the cap): a longer one is dropped by its own
  // ceiling, in this scanner and in the frozen one alike.
  const code = `"${Math.floor(rand() * 100_000_000)}"`
  return `{"usage":0,"\\u0075sage":{"pad":"${pad}"},"code":${code},"status":"completed"}`
}

/** A valid JSON document over the slot surface, with repeated keys and escaped ones. */
function document(rand: () => number, seedIndex: number): string {
  // Every third document is the planted budget shape, so the corpus reaches it every time.
  if (seedIndex % PLANTED_EVERY === 0) return plantedBudgetShape(rand)
  const members: Member[] = []
  const count = 2 + Math.floor(rand() * 5)
  for (let at = 0; at < count; at++) members.push(member(rand, members))
  if (members.length > 0 && rand() < 0.4) {
    const earlier = members[Math.floor(rand() * members.length)]
    if (earlier) members.push({ key: earlier.key, value: valueForKey(earlier.key, rand) })
  }
  return `{${members.map((entry) => `${entry.key.text}:${entry.value}`).join(",")}}`
}

test.each([
  '{"pad":"\\u0070","\\u006e":1.0}',
  '[1e20,1e-6,-0,1e400,-1e400,true,null,"é"]',
  '{"a":1,"a":2,"b":[{},[]]}',
  `${"[".repeat(10_000)}0${"]".repeat(10_000)}`,
])("normalization preserves values without expanding the byte budget: %.40s", (text) => {
  const bytes = [...encoder.encode(text)]
  const compact = compactSlotEncoding(bytes)
  expect(compact.length).toBeLessThanOrEqual(bytes.length)
  const decoder = new TextDecoder()
  expect(semanticFingerprint(compact, decoder)).toBe(semanticFingerprint(bytes, decoder))
})

test.each([
  '{"pad":"\\u0070","\\u006e":1.0}',
  '[1e20,1e-6,-0,1e400,-1e400,true,null,"é"]',
  '{"a":1,"a":2,"b":[{},[]]}',
  `${"[".repeat(10_000)}0${"]".repeat(10_000)}`,
  `{"pad":"\\u0070${"p".repeat(42)}"}`,
  `1.${"0".repeat(64)}`,
])("the canonical form preserves the value without expanding the byte budget: %.40s", (text) => {
  const bytes = [...encoder.encode(text)]
  const canonical = [...encoder.encode(canonicalize(text))]
  expect(canonical.length).toBeLessThanOrEqual(bytes.length)
  const decoder = new TextDecoder()
  expect(semanticFingerprint(canonical, decoder)).toBe(semanticFingerprint(bytes, decoder))
})

test.each([
  ['{"pad":            "p"', '{"pad":"p"'],
  ['{"pad":"\\u0070"', '{"pad":"p"'],
  ['{"pad":"p p"', '{"pad":"p p"'],
  ['{"pad":"unfinished\\u00', '{"pad":"unfinished\\u00'],
  ['{"pad":1  2', '{"pad":1 2'],
  ['{"pad":"\\q"', '{"pad":"\\q"'],
])("the canonical form preserves string and primitive boundaries: %s", (text, expected) => {
  const canonical = canonicalize(text)
  expect(canonical).toBe(expected)
  expect(encoder.encode(canonical).length).toBeLessThanOrEqual(encoder.encode(text).length)
})

test("the current scanner reads a document as JSON.parse does, over the whole slot surface", () => {
  for (let index = 0; index < ITERATIONS; index++) {
    const seed = (BASE_SEED + index) >>> 0
    const rand = prng(seed)
    const text = document(rand, index)
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

    assertRetainedValues(current.rebuilt, projection, report)
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
    const text = document(rand, index)
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
    // Dropping a slot is intentional; changing a retained value is not.
    assertRetainedValues(current.rebuilt, projection, report)
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

test.each(["q", "12345678"])(
  "an inherited escaped capture yields before non-stale literal code evidence: %s",
  (code) => {
    const text = `{"usage":0,"\\u0075sage":{"pad":"${"p".repeat(45)}"},"code":"${code}","status":"completed"}`
    const projection = project(JSON.parse(text) as Record<string, unknown>)
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    expect(frozen.rebuilt).toEqual({ usage: 0, code, status: "completed" })
    expect(projection).toMatchObject({ code, status: "completed" })
    expect(current.rebuilt).toEqual({ code, status: "completed" })
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test.each(["code", "error", "response.error"])(
  "an oversized optional %s is dropped, keeping the identical escaped usage",
  (path) => {
    const usage = { pad: "p".repeat(45) }
    const value = JSON.stringify(usage)
    const optional =
      path === "response.error"
        ? '"response":{"error":"12345678901234567"}'
        : `"${path}":"12345678901234567"`
    const text = `{"usage":${value},"\\u0075sage":${value},${optional}}`
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    // The escaped copy holds the value the literal slot held, so it is that slot: the optional
    // evidence is dropped at the full budget instead of borrowing the slot's room.
    expect(frozen.rebuilt).toEqual({ usage })
    expect(project(JSON.parse(text) as Record<string, unknown>)).toMatchObject({ usage })
    expect(current.rebuilt).toEqual(frozen.rebuilt)
    expect(current.retained).toBe(value.length)
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test.each(["code", "error", "response.error"])(
  "an oversized optional %s borrows an inherited usage of another value, and restores it",
  (path) => {
    // The escaped copy holds a value the literal slot did not, so it may lend its room: the
    // optional evidence is dropped by its own share, and the borrowed capture comes back.
    const escaped = { pad: "p".repeat(45) }
    const value = JSON.stringify(escaped)
    const optional =
      path === "response.error"
        ? '"response":{"error":"12345678901234567"}'
        : `"${path}":"12345678901234567"`
    const text = `{"usage":0,"\\u0075sage":${value},${optional}}`
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    // 2.41.0 read the literal `usage` — a value `JSON.parse` overwrites — and dropped the
    // optional evidence; the current scanner keeps the value `JSON.parse` reads.
    expect(frozen.rebuilt).toEqual({ usage: 0 })
    expect(project(JSON.parse(text) as Record<string, unknown>)).toMatchObject({ usage: escaped })
    expect(current.rebuilt).toEqual({ usage: escaped })
    expect(current.retained).toBe(value.length)
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test.each(["", " ", "\t", "\r\n"])(
  "a semantically identical escaped repeat keeps the frozen slot: %j",
  (whitespace) => {
    const usage = { pad: "p".repeat(45) }
    const value = JSON.stringify(usage)
    const escapedValue = value.replace(":", `:${whitespace}`)
    const text = `{"usage":${value},"\\u0075sage":${escapedValue},"code":"12345678"}`
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    // 2.41.0 read the literal `usage` and dropped the `code`: the optional evidence did not fit
    // beside it. The current scanner reads both spellings as the one slot, and the escaped copy
    // holds the same value — so it is that slot, and the optional evidence yields instead.
    expect(frozen.rebuilt).toEqual({ usage })
    expect(current.rebuilt).toEqual({ usage })
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test.each(["    ", "\t\r\n ", " ".repeat(12)])(
  "an equivalent expanded repeat leaves room for required status: %j",
  (whitespace) => {
    const usage = { pad: "p".repeat(43) }
    const value = JSON.stringify(usage)
    const expanded = value.replace(":", `:${whitespace}`)
    const text = `{"usage":${value},"\\u0075sage":${expanded},"status":"completed"}`
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    expect(frozen.rebuilt).toEqual({ usage, status: "completed" })
    expect(frozen.retained).toBe(64)
    expect(current.rebuilt).toEqual(frozen.rebuilt)
    expect(current.retained).toBe(64)
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test("the tight-cap oracle rejects a changed status but permits only a root error placeholder", () => {
  const projection = { status: "completed", error: { code: "upstream" } }
  expect(() => assertRetainedValues({ status: "failed" }, projection, String)).toThrow()
  expect(() => assertRetainedValues({ error: {} }, projection, String)).not.toThrow()
  expect(() => assertRetainedValues({ usage: {} }, { usage: { tokens: 1 } }, String)).toThrow()
  expect(() => assertRetainedValues({ error: {} }, { error: "failed" }, String)).toThrow()
})

test("an equivalent string escape leaves room for required status", () => {
  const usage = { pad: "p".repeat(43) }
  const value = JSON.stringify(usage)
  const expanded = value.replace("p".repeat(43), `\\u0070${"p".repeat(42)}`)
  const text = `{"usage":${value},"\\u0075sage":${expanded},"status":"completed"}`
  const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
  const current = run(createResponseSalvage, text, TIGHT_CAP)
  expect(frozen.rebuilt).toEqual({ usage, status: "completed" })
  expect(current.rebuilt).toEqual(frozen.rebuilt)
  expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
})

/**
 * The escaped repeats that lost their slot: the repeat spelled the same value longer, so it
 * spent more room than the slot was worth and was dropped where the frozen scanner kept the
 * slot (#209: no lost non-stale key). The canonical form of a value is what it costs, so the
 * repeat fits the room the literal slot freed.
 */
test.each([
  // The same 43-character value, one padding character spelled `\u0070`: five bytes longer.
  `{"usage":{"pad":"${"p".repeat(43)}"},"status":"completed","\\u0075sage":{"pad":"\\u0070${"p".repeat(42)}"}}`,
  // The same value, an expanded number: sixty-five bytes longer.
  `{"usage":1,"\\u0075sage":1.${"0".repeat(64)},"status":"completed"}`,
  // The same expanded number, behind the status that fills the budget.
  `{"usage":1,"status":"completed","\\u0075sage":1.${"0".repeat(64)}}`,
])("an equivalent escaped repeat keeps the slot the frozen scanner kept: %.60s", (text) => {
  const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
  const current = run(createResponseSalvage, text, TIGHT_CAP)
  const projection = project(JSON.parse(text) as Record<string, unknown>)
  // The frozen scanner read the literal slot and the status; `JSON.parse` reads the same
  // values, so the current scanner may lose neither of them.
  expect(frozen.rebuilt).toEqual(projection)
  expect(current.rebuilt).toEqual(projection)
  expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
})

test.each([false, true])(
  "a replaced parent carries priority, not stale children: %j",
  (omitUsage) => {
    const usage = { pad: "p".repeat(45) }
    const value = JSON.stringify(usage)
    const text = `{"response":{"usage":${value}},"\\u0072esponse":${omitUsage ? "{}" : `{"usage":${value}}`},"code":"12345678"}`
    const frozen = run(createFrozenSalvage, text, TIGHT_CAP)
    const current = run(createResponseSalvage, text, TIGHT_CAP)
    expect(frozen.rebuilt).toEqual({ response: { usage } })
    expect(current.rebuilt).toEqual(omitUsage ? { code: "12345678" } : { response: { usage } })
    assertRetainedValues(
      current.rebuilt,
      project(JSON.parse(text) as Record<string, unknown>),
      String,
    )
    expect(current.peak).toBeLessThanOrEqual(TIGHT_CAP)
  },
)

test("historical comparison metadata stays fixed-size for a 60,000-byte replacement", () => {
  const value = JSON.stringify({ pad: "p".repeat(59_990) })
  expect(value.length).toBe(60_000)
  const fingerprint = semanticFingerprint([...encoder.encode(value)], new TextDecoder())
  expect(typeof fingerprint).toBe("string")
  expect(fingerprint?.length).toBe(64)
  const text = `{"usage":${value},"\\u0075sage":${value}}`
  const current = run(createResponseSalvage, text, 65_536)
  expect(current.rebuilt).toEqual({ usage: JSON.parse(value) })
  expect(current.retained).toBe(60_000)
  expect(current.peak).toBeLessThanOrEqual(65_536)
})

test.each([
  ['{"a":1,"b":[true,null]}', '{"b":[true,null],"a":1.0}'],
  ['"p"', '"\\u0070"'],
  ["-0", "0"],
])("semantic metadata ignores JSON spelling: %s / %s", (left, right) => {
  const fingerprint = (text: string) =>
    semanticFingerprint([...encoder.encode(text)], new TextDecoder())
  expect(fingerprint(left)).not.toBeNull()
  expect(fingerprint(left)).toBe(fingerprint(right))
  expect(fingerprint(left)).not.toBe(fingerprint('"different"'))
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
  let budgetShape = 0
  for (let index = 0; index < ITERATIONS; index++) {
    const text = document(prng((BASE_SEED + index) >>> 0), index)
    const current = flatten(run(createResponseSalvage, text, CAP).rebuilt)
    const frozen = flatten(run(createFrozenSalvage, text, CAP).rebuilt)
    // A member 2.41.0 kept under a replaced parent, and one the current scanner matched by decoding.
    if ([...frozen.keys()].some((path) => !current.has(path))) staleChild++
    if ([...current.keys()].some((path) => !frozen.has(path))) escapedSlot++
    // The `{}` 2.41.0 rebuilt in place of a later non-object root error.
    if (frozen.has("error") && sameValue(frozen.get("error"), {})) placeholder++
    // The budget shape: at the tight cap the escaped copy of a root slot gave way, so the `code`
    // behind it survived — a shape 2.41.0 read with both members.
    const tight = flatten(run(createResponseSalvage, text, TIGHT_CAP).rebuilt)
    const tightFrozen = flatten(run(createFrozenSalvage, text, TIGHT_CAP).rebuilt)
    if (tight.has("code") && tightFrozen.has("code") && !tight.has("usage")) budgetShape++
  }
  expect(staleChild).toBeGreaterThan(0)
  expect(escapedSlot).toBeGreaterThan(0)
  expect(placeholder).toBeGreaterThan(0)
  expect(budgetShape).toBeGreaterThan(0)
})
