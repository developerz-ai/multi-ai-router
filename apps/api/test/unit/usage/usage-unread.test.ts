import { expect, test } from "bun:test"
import { createResponseObserver } from "../../../src/services/usage/response-observer"
import { usageUnread } from "../../../src/services/usage/usage-unread"

const NONE = { usageStated: false, usageInvalid: false, evidenceUnavailable: false }

test("a stated sample is a measurement, whatever else the observation lost", () => {
  expect(usageUnread({ ...NONE, usageStated: true })).toBeNull()
  expect(
    usageUnread({ usageStated: true, usageInvalid: true, evidenceUnavailable: true }),
  ).toBeNull()
})

test("no sample names why: invalid before unobservable before unreported", () => {
  expect(usageUnread({ ...NONE, usageInvalid: true, evidenceUnavailable: true })).toBe(
    "usage_invalid",
  )
  expect(usageUnread({ ...NONE, evidenceUnavailable: true })).toBe("usage_unobservable")
  expect(usageUnread(NONE)).toBe("usage_unreported")
})

function observe(frames: readonly string[]) {
  const observer = createResponseObserver({
    dialect: "openai-responses",
    operation: "messages",
    contentType: "text/event-stream",
    maximumObservationBytes: 65_536,
  })
  for (const frame of frames) observer.observe(new TextEncoder().encode(frame))
  return observer.finish()
}

const data = (payload: object) => `data: ${JSON.stringify(payload)}\n\n`

test("the observer says whether a usage sample was read, apart from the counts", () => {
  const completed = (usage: unknown) => data({ type: "response.completed", response: { usage } })
  expect(observe([completed({ input_tokens: 0, output_tokens: 0 })])).toMatchObject({
    usageStated: true,
    counts: { tokensIn: 0, tokensOut: 0 },
  })
  expect(observe([completed(undefined)])).toMatchObject({ usageStated: false })
  expect(observe([data({ type: "response.created", response: {} })])).toMatchObject({
    usageStated: false,
    terminal: "none",
  })
  expect(
    observe([completed({ input_tokens: 1, input_tokens_details: { cached_tokens: 5 } })]),
  ).toMatchObject({ usageStated: false, usageInvalid: true })
})
