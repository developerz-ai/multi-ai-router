import { describe, expect, test } from "bun:test"
import { estimateCost, UNKNOWN_COST } from "../../../src/services/cost"
import {
  type CostReport,
  stampUsageBody,
  stampUsageFrame,
  usageCostFields,
  usageFrameIndex,
} from "../../../src/services/dataplane/relay-cost"

const COUNTS = { tokensIn: 10, tokensOut: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }
const CLEAN = { counts: COUNTS, usageInvalid: false, evidenceUnavailable: false }
const PRICED = { costEstimate: "0.210000", costBasis: "metered" } as const
const FIELDS = { cost: 0.21, cost_source: "estimated", cost_basis: "metered" } as const

function report(ingress: CostReport["ingress"], fields: CostReport["fields"]): CostReport {
  return { ingress, fields }
}

describe("usageCostFields: absent, never zero", () => {
  test("no rate states nothing", () => {
    expect(usageCostFields(CLEAN, UNKNOWN_COST)).toBeNull()
  })

  test("counts the upstream never stated price to no claim at all", () => {
    const counts = { tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    expect(
      usageCostFields({ ...CLEAN, counts }, { ...PRICED, costEstimate: "0.000000" }),
    ).toBeNull()
  })

  test("counts that may be partial state nothing", () => {
    expect(usageCostFields({ ...CLEAN, usageInvalid: true }, PRICED)).toBeNull()
    expect(usageCostFields({ ...CLEAN, evidenceUnavailable: true }, PRICED)).toBeNull()
  })

  test("a priced attempt states USD, as a number, with its provenance", () => {
    expect(usageCostFields(CLEAN, PRICED)).toEqual(FIELDS)
  })

  test("a subscription's figure is labelled notional", () => {
    expect(usageCostFields(CLEAN, { ...PRICED, costBasis: "notional" })?.cost_basis).toBe(
      "notional",
    )
  })

  test("the long-context tier rides along with the estimate", () => {
    const priced = (tokensIn: number) =>
      usageCostFields(
        CLEAN,
        estimateCost({
          provider: "openai-api",
          model: "gpt-6.1-sol",
          tokens: { ...COUNTS, tokensIn, tokensOut: 1_000 },
        }),
      )?.cost
    expect(priced(300_000)).toBe(1.215)
    expect(priced(100_000)).toBe(0.21)
  })
})

describe("usageFrameIndex", () => {
  test("anthropic: the delta, never message_start", () => {
    const events = [
      { event: "message_start", data: '{"message":{"usage":{"input_tokens":1}}}' },
      { event: "message_delta", data: '{"usage":{"output_tokens":1}}' },
    ]
    expect(usageFrameIndex("anthropic", events)).toBe(1)
  })

  test("openai-chat: a usage object, not a content chunk's null nor text quoting one", () => {
    const events = [
      { data: '{"choices":[{"delta":{"content":"\\"usage\\":{"}}],"usage":null}' },
      { data: '{"choices":[],"usage":{"prompt_tokens":1}}' },
    ]
    expect(usageFrameIndex("openai-chat", events)).toBe(1)
    expect(usageFrameIndex("openai-chat", [{ data: "[DONE]" }])).toBe(-1)
  })

  test("openai-chat: read by parsing, so spacing does not hide the usage chunk", () => {
    expect(
      usageFrameIndex("openai-chat", [{ data: '{"choices": [], "usage": {"prompt_tokens": 1}}' }]),
    ).toBe(0)
  })

  test("openai-chat: only the final usage chunk, not a content chunk that also carries usage", () => {
    const events = [
      { data: '{"choices":[{"delta":{"content":"hi"}}],"usage":{"prompt_tokens":1}}' },
      { data: '{"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}' },
    ]
    expect(usageFrameIndex("openai-chat", events)).toBe(1)
    expect(usageFrameIndex("openai-chat", events.slice(0, 1))).toBe(-1)
  })

  test("openai-responses: the terminal events, and not a failed one", () => {
    const failed = { event: "response.failed", data: '{"response":{"usage":{"input_tokens":1}}}' }
    const done = { event: "response.incomplete", data: '{"response":{"usage":{"input_tokens":1}}}' }
    expect(usageFrameIndex("openai-responses", [failed])).toBe(-1)
    expect(usageFrameIndex("openai-responses", [failed, done])).toBe(1)
  })
})

describe("stamping", () => {
  test("a frame keeps its members and gains the cost beside the counts", () => {
    const stamped = stampUsageFrame(
      report("anthropic", () => FIELDS),
      {
        event: "message_delta",
        data: '{"type":"message_delta","usage":{"output_tokens":5}}',
      },
    )
    expect(stamped.event).toBe("message_delta")
    expect(JSON.parse(stamped.data)).toEqual({
      type: "message_delta",
      usage: { output_tokens: 5, ...FIELDS },
    })
  })

  test("a Responses terminal keeps its usage inside the response object", () => {
    const stamped = stampUsageFrame(
      report("openai-responses", () => FIELDS),
      {
        event: "response.completed",
        data: '{"type":"response.completed","response":{"id":"r","usage":{"input_tokens":1}}}',
      },
    )
    expect(JSON.parse(stamped.data).response.usage).toEqual({ input_tokens: 1, ...FIELDS })
  })

  test("no fields, no usage, or a fault leaves the frame exactly as it was", () => {
    const frame = { event: "message_delta", data: '{"usage":{"output_tokens":5}}' }
    expect(
      stampUsageFrame(
        report("anthropic", () => null),
        frame,
      ),
    ).toBe(frame)
    const bare = { event: "message_delta", data: '{"delta":{}}' }
    expect(
      stampUsageFrame(
        report("anthropic", () => FIELDS),
        bare,
      ),
    ).toBe(bare)
    const broken = report("anthropic", () => {
      throw new Error("price book fault")
    })
    expect(stampUsageFrame(broken, frame)).toBe(frame)
  })

  test("a body reads whole, and a body with no usage stays as it was", () => {
    const whole: boolean[] = []
    const fields = (value: boolean) => {
      whole.push(value)
      return FIELDS
    }
    expect(stampUsageBody(report("openai-chat", fields), { id: "x", usage: { a: 1 } })).toEqual({
      id: "x",
      usage: { a: 1, ...FIELDS },
    })
    expect(whole).toEqual([true])
    const bare = { id: "x" }
    expect(
      stampUsageBody(
        report("openai-chat", () => FIELDS),
        bare,
      ),
    ).toBe(bare)
  })
})
