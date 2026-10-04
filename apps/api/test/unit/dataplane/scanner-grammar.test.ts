import { expect, test } from "bun:test"
import { decodeString } from "../../../src/services/dataplane/body/decode"
import { rewriteModel } from "../../../src/services/dataplane/body/read"
import { createRoutingScanner } from "../../../src/services/dataplane/body/scanner"

const enc = new TextEncoder()
const scan = (body: string, cut: number) => {
  const s = createRoutingScanner()
  const b = enc.encode(body)
  s.push(b.slice(0, cut))
  s.push(b.slice(cut))
  return s.finish()
}
const opening = '{"model":"claude","messages":[{"role":"user","content":"hello"}]}'
const appended =
  '{"model":"claude","messages":[{"role":"user","content":"hello"},{"role":"assistant","content":"hi"},{"role":"user","content":"next"}]}'
interface GrammarCase {
  name: string
  body: string
  model?: string
  duplicate?: boolean
  invalid?: boolean
  empty?: boolean
}
const cases: GrammarCase[] = [
  {
    name: "escaped model and key",
    body: String.raw`{"mo\u0064el":"claude\u002dsonnet","messages":[{"content":"hi","role":"user"}]}`,
    model: "claude-sonnet",
  },
  {
    name: "duplicate after cap",
    body:
      '{"model":"first","messages":[{"content":"' +
      "x".repeat(1300) +
      '","role":"user"}],"mo\\u0064el":"second"}',
    duplicate: true,
  },
  { name: "opening", body: opening, model: "claude" },
  { name: "appended", body: appended, model: "claude" },
  {
    name: "skip system role last",
    body: '{"messages":[{"content":"system","role":"system"},{"content":"hello","role":"user"}],"model":"claude"}',
    model: "claude",
  },
  {
    name: "Responses string",
    body: '{"model":"claude","input":"hello"}',
    model: "claude",
  },
  {
    name: "Responses other string",
    body: '{"model":"claude","input":"goodbye"}',
    model: "claude",
  },
  {
    name: "no user",
    body: '{"model":"claude","messages":[{"role":"assistant","content":"hello"}]}',
    empty: true,
  },
  { name: "mismatch", body: '{"model":"claude","messages":[]]', invalid: true },
  {
    name: "unterminated",
    body: '{"model":"claude","messages":["unterminated',
    invalid: true,
  },
  { name: "trailing document", body: '{"model":"claude"}{}', invalid: true },
  { name: "trailing comma", body: '{"model":"claude",}', invalid: true },
]
cases.push(
  { name: "unknown bad escape", body: String.raw`{"model":"m","other":"\q"}`, invalid: true },
  { name: "unknown bad unicode", body: String.raw`{"model":"m","other":"\u12xz"}`, invalid: true },
  {
    name: "unknown incomplete unicode",
    body: String.raw`{"model":"m","other":"\u12"}`,
    invalid: true,
  },
  {
    name: "unknown escaped quote valid",
    body: String.raw`{"model":"m","other":"a\"b\\c\u0020"}`,
    model: "m",
  },
  { name: "root scalar", body: "true", invalid: true },
  { name: "root array", body: '[{"model":"m"}]', invalid: true },
  { name: "missing colon", body: '{"model" "m"}', invalid: true },
  { name: "missing value", body: '{"model":}', invalid: true },
  { name: "array trailing comma", body: '{"model":"m","other":[1,]}', invalid: true },
  { name: "adjacent values", body: '{"model":"m","other":[1 2]}', invalid: true },
  { name: "unknown bad literal", body: '{"model":"m","other":truefalse}', invalid: true },
  { name: "unknown leading zero", body: '{"model":"m","other":01}', invalid: true },
  { name: "unknown incomplete exponent", body: '{"model":"m","other":1e+}', invalid: true },
  {
    name: "unknown long number valid",
    body: '{"model":"m","other":' + "1".repeat(1500) + "}",
    model: "m",
  },
  {
    name: "duplicate role",
    body: '{"model":"m","messages":[{"role":"user","content":"hi","role":"assistant"}]}',
    invalid: true,
  },
  {
    name: "duplicate conversation",
    body: '{"model":"m","messages":[],"messages":[]}',
    invalid: true,
  },
  {
    name: "ambiguous messages input",
    body: '{"model":"m","messages":[],"input":"hi"}',
    invalid: true,
  },
  {
    name: "duplicate model nonstring",
    body: '{"model":"m","mo\\u0064el":null}',
    duplicate: true,
    invalid: true,
  },
  {
    name: "nested model does not duplicate",
    body: '{"model":"m","other":{"model":"n"}}',
    model: "m",
  },
  { name: "empty Responses string", body: '{"model":"m","input":""}', empty: true },
  { name: "missing user content", body: '{"model":"m","messages":[{"role":"user"}]}', empty: true },
  {
    name: "empty user content",
    body: '{"model":"m","messages":[{"role":"user","content":""}]}',
    empty: true,
  },
  {
    name: "empty user content array",
    body: '{"model":"m","messages":[{"role":"user","content":[]}]}',
    empty: true,
  },
  {
    name: "nonempty user content array",
    body: '{"model":"m","messages":[{"role":"user","content":[{"type":"text","text":"hi"}]}]}',
    model: "m",
  },
)
for (let control = 0; control < 32; control++)
  cases.push({
    name: "unknown control " + control,
    body: '{"model":"m","other":"a' + String.fromCharCode(control) + 'b"}',
    invalid: true,
  })
cases.push({ name: "unicode unknown string", body: '{"model":"m","other":"😀é漢字"}', model: "m" })
for (const malformed of [
  [0x80],
  [0xc0, 0xaf],
  [0xed, 0xa0, 0x80],
  [0xf4, 0x90, 0x80, 0x80],
  [0xe2, 0x82],
]) {
  const before = enc.encode('{"model":"m","other":"'),
    after = enc.encode('"}'),
    bytes = Uint8Array.from([...before, ...malformed, ...after])
  for (let cut = 0; cut <= bytes.length; cut++) {
    const scanner = createRoutingScanner()
    scanner.push(bytes.slice(0, cut))
    scanner.push(bytes.slice(cut))
    if (!scanner.finish().invalid) throw Error("malformed UTF8 accepted")
  }
}
for (const maximumJsonDepth of [2, 8, 256]) {
  const body = (depth: number) =>
    '{"model":"m","other":' + "[".repeat(depth - 1) + "0" + "]".repeat(depth - 1) + "}"
  const at = createRoutingScanner({ maximumJsonDepth })
  at.push(enc.encode(body(maximumJsonDepth)))
  if (at.finish().invalid) throw Error("at max depth rejected")
  const over = createRoutingScanner({ maximumJsonDepth })
  over.push(enc.encode(body(maximumJsonDepth + 1)))
  if (!over.finish().depthExceeded) throw Error("over max depth accepted")
}
cases.push(
  {
    name: "opaque array valid escaped unicode",
    body: String.raw`{"model":"m","other":["hi","a\"b","漢字😀","\uD83D\uDE00"]}`,
    model: "m",
  },
  { name: "opaque array missing comma", body: '{"model":"m","other":["a" "b"]}', invalid: true },
  { name: "opaque array trailing comma", body: '{"model":"m","other":["a","b",]}', invalid: true },
  { name: "opaque array double comma", body: '{"model":"m","other":["a",,"b"]}', invalid: true },
  {
    name: "opaque array bad escape",
    body: String.raw`{"model":"m","other":["a","\q","b"]}`,
    invalid: true,
  },
  {
    name: "opaque array bad unicode",
    body: String.raw`{"model":"m","other":["a","\u12xz","b"]}`,
    invalid: true,
  },
  { name: "opaque array unterminated", body: '{"model":"m","other":["a","b', invalid: true },
  {
    name: "opaque array primitives mixed",
    body: '{"model":"m","other":["a",true,"b",{},"c",[],"d",1]}',
    model: "m",
  },
  {
    name: "opaque array escaped backslash end",
    body: String.raw`{"model":"m","other":["a\\","b"]}`,
    model: "m",
  },
  {
    name: "opaque array controls",
    body: '{"model":"m","other":["a","b\u0000c","d"]}',
    invalid: true,
  },
)
for (const c of cases)
  test(`grammar and chunk independence: ${c.name}`, () => {
    const n = enc.encode(c.body).length,
      observations = new Set<string>()
    for (let cut = 0; cut <= n; cut++) {
      const r = scan(c.body, cut)
      if (c.model && r.model !== c.model) throw Error(c.name + " model " + r.model)
      if (c.invalid && !r.invalid) throw Error(c.name + " accepted")
      if (c.duplicate && !r.duplicateModel) throw Error(c.name + " duplicate missed")
      if (c.empty && r.conversationPrefix.length) throw Error(c.name + " captured")
      observations.add(JSON.stringify(r))
    }
    expect(observations.size).toBe(1)
  })
test("bounds, capture ownership, opening identity and byte-exact alias span", () => {
  for (const bad of [NaN, Infinity, -Infinity, 0, -1, 1.5, 65537]) {
    let threw = false
    try {
      createRoutingScanner({ conversationPrefixBytes: bad })
    } catch (error) {
      threw = error instanceof RangeError
    }
    if (!threw) throw Error("unsafe prefix option accepted:" + bad)
  }
  for (const bad of [NaN, Infinity, -Infinity, 0, 1, -1, 2.5, 4097]) {
    let threw = false
    try {
      createRoutingScanner({ maximumJsonDepth: bad })
    } catch (error) {
      threw = error instanceof RangeError
    }
    if (!threw) throw Error("unsafe depth option accepted:" + bad)
  }
  for (const opts of [
    {},
    { conversationPrefixBytes: 1 },
    { conversationPrefixBytes: 65536 },
    { maximumJsonDepth: 2 },
    { maximumJsonDepth: 4096 },
  ])
    createRoutingScanner(opts)
  const immutable = createRoutingScanner()
  immutable.push(enc.encode(opening))
  const firstSnapshot = immutable.finish().conversationPrefix
  const expectedSnapshot = firstSnapshot.slice()
  firstSnapshot.fill(0)
  if (!Buffer.from(immutable.result().conversationPrefix).equals(Buffer.from(expectedSnapshot)))
    throw Error("result aliases mutable capture")
  const reused = createRoutingScanner({ conversationPrefixBytes: 5 })
  reused.push(
    enc.encode(
      '{"model":"m","messages":[{"role":"system","content":"first"},{"role":"assistant","content":"second"},{"role":"user","content":"third"}]}',
    ),
  )
  if (new TextDecoder().decode(reused.finish().conversationPrefix) !== '{"rol')
    throw Error("discarded candidate reuse incorrect")

  const a = scan(opening, 0),
    b = scan(appended, 0)
  if (!Buffer.from(a.conversationPrefix).equals(Buffer.from(b.conversationPrefix)))
    throw Error("opening unstable")
  if (
    Buffer.from(scan(requiredCase(5).body, 0).conversationPrefix).equals(
      Buffer.from(scan(requiredCase(6).body, 0).conversationPrefix),
    )
  )
    throw Error("Responses collision")
  if (decodeString([...enc.encode(String.raw`\uD83D\uDE00`)]) !== "😀")
    throw Error("surrogate decode")
  const aliasBody = String.raw`{"model":"claude-sonnet","other":"verbatim  whitespace","input":"hello"}`
  const aliasScan = scan(aliasBody, 13),
    wire = enc.encode(aliasBody)
  if (!aliasScan.modelSpan) throw Error("missing model span")
  const rewritten = rewriteModel(wire, aliasScan.modelSpan, 'upstream-"alias')
  const expected =
    aliasBody.slice(0, aliasScan.modelSpan.start) +
    JSON.stringify('upstream-"alias').slice(1, -1) +
    aliasBody.slice(aliasScan.modelSpan.end)
  if (new TextDecoder().decode(rewritten) !== expected) throw Error("alias changed opaque bytes")
})
function requiredCase(index: number) {
  const found = cases[index]
  if (!found) throw new Error("missing grammar fixture")
  return found
}
