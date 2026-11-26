import { describe, expect, test } from "bun:test"
import { openRouterDriver } from "../../../src/providers/drivers/openrouter"
import { createResponseObserver } from "../../../src/services/usage"

/**
 * The observer reads an upstream's own cost off the usage object it already parses, and only for a
 * driver that states one: OpenRouter's final stream chunk or JSON body.
 */

const encoder = new TextEncoder()
const descriptor = openRouterDriver.responseObservation

function observe(
  contentType: string,
  text: string,
  options: { readonly driverStatesCost?: boolean; readonly maximumObservationBytes?: number } = {},
) {
  const observer = createResponseObserver({
    dialect: "openai-chat",
    operation: "messages",
    contentType,
    maximumObservationBytes: options.maximumObservationBytes ?? 4096,
    ...(options.driverStatesCost === false || descriptor === undefined ? {} : { descriptor }),
  })
  observer.observe(encoder.encode(text))
  return observer.finish()
}

const frame = (fields: object) => `data: ${JSON.stringify({ id: "c", ...fields })}\n\n`
const CONTENT = frame({ choices: [{ index: 0, delta: { content: "ok" } }] })
const usageChunk = (usage: object) =>
  frame({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, ...usage } })
const stream = (usage: object) =>
  observe("text/event-stream", `${CONTENT}${usageChunk(usage)}data: [DONE]\n\n`)

describe("no trustworthy figure: null, and the counts are untouched", () => {
  test("a final chunk without cost", () => {
    const facts = stream({})
    expect(facts.reportedCost).toBeNull()
    expect(facts.counts.tokensIn).toBe(10)
  })

  test("a malformed cost is ignored, not a crash and not a reading", () => {
    for (const cost of ['"0.5"', "-1", "null", "{}", "1e999"]) {
      const text = `${CONTENT}data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"cost":${cost}}}\n\ndata: [DONE]\n\n`
      const facts = observe("text/event-stream", text)
      expect(facts.reportedCost).toBeNull()
      expect(facts.usageInvalid).toBe(false)
      expect(facts.counts.tokensOut).toBe(2)
    }
  })

  test("a driver that states no cost reads none, even where the body carries one", () => {
    const text = `${CONTENT}${usageChunk({ cost: 0.5 })}data: [DONE]\n\n`
    expect(observe("text/event-stream", text, { driverStatesCost: false }).reportedCost).toBeNull()
  })
})

describe("OpenRouter's figure is read in the same pass as the counts", () => {
  test("the final stream chunk", () => {
    const facts = stream({ cost: 0.012345 })
    expect(facts.reportedCost).toBe(0.012345)
    expect(facts.counts).toMatchObject({ tokensIn: 10, tokensOut: 2 })
  })

  test("a whole JSON body", () => {
    const body = JSON.stringify({
      id: "c",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.75 },
    })
    expect(observe("application/json", body).reportedCost).toBe(0.75)
  })

  test("a JSON body past the observation cap: the salvaged usage still carries it", () => {
    const body = JSON.stringify({
      id: "c",
      choices: [{ index: 0, message: { role: "assistant", content: "x".repeat(20_000) } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.75 },
    })
    const facts = observe("application/json", body, { maximumObservationBytes: 4096 })
    expect(facts.counts.tokensOut).toBe(2)
    expect(facts.reportedCost).toBe(0.75)
  })
})
