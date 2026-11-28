import { describe, expect, test } from "bun:test"
import { createLogger } from "../../src/logging/logger"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * Prod 2026-11-10/11 (v2.57.0): 1,644 translated `/v1/chat/completions` → ChatGPT (Codex) attempts
 * in three days were recorded `success`, `streamed`, HTTP 200, with all four token columns at 0
 * and `cost_estimate 0.000000 notional` (e.g. usage row fb39c9de…, 07:53:45Z). Once a session
 * flipped it stayed flipped until it ended. The upstream stream carried no usage the observer
 * could read. The observer knew that, but the record never asked, so the row read as a free
 * completion and quota and cost reports undercounted. The upstream is a mock and nothing
 * reaches chatgpt.com.
 *
 * The rule (06-protocol-translation.md, "Absent, never zero"): usage that was never stated is
 * unknown. Token columns are NULL because no number was measured (they were 0 until plan 101
 * slice 09, R3). Cost is NULL with basis `unknown`, and `errorClass` names why, so a `GROUP BY`
 * finds these rows.
 */

const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-usage-unread" } }),
).toString("base64url")}.sig`

function codexAccount() {
  return {
    ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
}

let sequence = 0
function frame(type: string, fields: object): string {
  sequence += 1
  return `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence, ...fields })}\n\n`
}

const RESPONSE = { id: "resp_1", object: "response", model: "gpt-5.6-terra" }
const MESSAGE = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "hello", annotations: [] }],
}
const USAGE = {
  input_tokens: 21,
  input_tokens_details: { cached_tokens: 3 },
  output_tokens: 9,
  output_tokens_details: { reasoning_tokens: 4 },
  total_tokens: 30,
}

/** Everything up to the final event; `last` is that event, or nothing at all. */
function stream(last: string): Response {
  sequence = 0
  const text = { item_id: "msg_1", output_index: 0, content_index: 0 }
  const body = [
    frame("response.created", { response: { ...RESPONSE, status: "in_progress", output: [] } }),
    frame("response.output_item.added", {
      output_index: 0,
      item: { ...MESSAGE, status: "in_progress", content: [] },
    }),
    frame("response.output_text.delta", { ...text, delta: "hello" }),
    frame("response.output_item.done", { output_index: 0, item: MESSAGE }),
    last,
  ].join("")
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
}

const completed = (usage: unknown) =>
  frame("response.completed", {
    response: { ...RESPONSE, status: "completed", output: [MESSAGE], usage },
  })

const CHAT_REQUEST = {
  path: "/v1/chat/completions",
  body: {
    model: "gpt-5.6-terra",
    stream: true,
    stream_options: { include_usage: true },
    messages: [{ role: "user", content: "hi" }],
  },
}

/** GPT behind the Anthropic wire: the Anthropic answer has no reasoning field to carry. */
const MESSAGES_REQUEST = {
  path: "/v1/messages",
  body: {
    model: "gpt-5.6-terra",
    max_tokens: 128_000,
    stream: true,
    messages: [{ role: "user", content: "hi" }],
  },
}

async function drive(
  last: () => string,
  request: { readonly path: string; readonly body: object } = CHAT_REQUEST,
) {
  const lines: Record<string, unknown>[] = []
  const logger = createLogger({
    level: "warn",
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  })
  const { app, usage } = harness({
    accounts: [codexAccount()],
    responses: [() => stream(last())],
    logger,
  })
  const res = await app.request(request.path, post(JSON.stringify(request.body), bearer()))
  expect(res.status).toBe(200)
  expect(await res.text()).toContain("hello")
  await settle()
  expect(usage.rows).toHaveLength(1)
  return { row: usage.rows[0], lines }
}

const UNKNOWN_USAGE = {
  outcome: "success",
  streamed: true,
  httpStatus: 200,
  responseStatus: 200,
  tokensIn: null,
  tokensOut: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: null,
  costEstimate: null,
  costBasis: "unknown",
}

describe("a translated Codex success whose usage was never read", () => {
  test("a stream that ends without response.completed is recorded as incomplete, never as a success", async () => {
    const { row, lines } = await drive(() => "")
    expect(row).toMatchObject({
      ...UNKNOWN_USAGE,
      outcome: "upstream_error",
      errorClass: "upstream_incomplete",
    })
    const line = lines.find((entry) => entry.msg === "upstream response incomplete")
    expect(line).toMatchObject({ reason: "no-terminal-event" })
    // The upstream's event tally is the evidence an operator reads to tell the shapes apart.
    expect(line?.eventTypes).toMatchObject({ "response.output_item.done": 1 })
  })

  test("a response.completed that states no usage is recorded as unreported", async () => {
    const { row, lines } = await drive(() => completed(undefined))
    expect(row).toMatchObject({ ...UNKNOWN_USAGE, errorClass: "usage_unreported" })
    expect(lines.find((entry) => entry.msg === "upstream usage unread")).toMatchObject({
      terminal: "completed",
    })
  })

  test("a usage block the observer cannot trust is recorded as invalid", async () => {
    const { row } = await drive(() =>
      completed({ ...USAGE, input_tokens_details: { cached_tokens: 99 } }),
    )
    expect(row).toMatchObject({ ...UNKNOWN_USAGE, errorClass: "usage_invalid" })
  })

  test("stated usage is still recorded and priced, with no class and no line", async () => {
    const { row, lines } = await drive(() => completed(USAGE))
    expect(row).toMatchObject({
      outcome: "success",
      tokensIn: 18,
      tokensOut: 9,
      cacheReadTokens: 3,
      reasoningTokens: 4,
      costBasis: "notional",
      errorClass: null,
    })
    expect(lines.some((entry) => entry.msg === "upstream usage unread")).toBe(false)
  })

  test("reasoning a GPT upstream states survives the Anthropic wire into the row", async () => {
    const { row } = await drive(() => completed(USAGE), MESSAGES_REQUEST)
    expect(row).toMatchObject({
      outcome: "success",
      ingressDialect: "anthropic",
      tokensIn: 18,
      tokensOut: 9,
      cacheReadTokens: 3,
      reasoningTokens: 4,
      errorClass: null,
    })
  })
})

/**
 * Prod (Codex OAuth, about 4% of one account's passthrough `/v1/responses` requests): `success` +
 * `usage_unobservable` with `"terminal":"none"`, `"lostTo":"salvage"` and an event tally that
 * stops at `response.output_item.added` / `item.function_call`. A Codex `response.completed`
 * echoes instructions, tools and output, so it is over the observation cap and read by the
 * bounded salvage scanner; the scanner reads such a frame whole (`response-salvage.test.ts`). It
 * loses one only when the bytes stop before the frame closes: the stream ended inside it, and no
 * reader could take usage from a half object. The line used to call that `salvage`, which reads
 * as a scanner fault; it now says `trailing`, as for a small frame cut the same way, and the tally
 * names the frame that was lost.
 */
describe("a same-dialect Codex stream that ends inside its over-cap response.completed", () => {
  test("keeps the row as unknown usage and names the cut frame on the log line", async () => {
    sequence = 0
    const call = { type: "function_call", id: "fc_1", call_id: "call_1", name: "shell" }
    const whole = frame("response.completed", {
      response: {
        ...RESPONSE,
        status: "completed",
        instructions: "i".repeat(100_000),
        output: [{ ...call, arguments: "{}" }],
        usage: USAGE,
      },
    })
    const body = [
      frame("response.created", { response: { ...RESPONSE, status: "in_progress" } }),
      frame("response.in_progress", { response: { ...RESPONSE, status: "in_progress" } }),
      frame("response.output_item.added", { output_index: 0, item: call }),
      // Cut after the bytes passed the cap and before the object closed.
      whole.slice(0, 90_000),
    ].join("")
    const lines: Record<string, unknown>[] = []
    const logger = createLogger({
      level: "warn",
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    })
    const { app, usage } = harness({
      accounts: [codexAccount()],
      responses: [
        () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
      ],
      logger,
    })
    const request = { model: "gpt-5.6-terra", stream: true, store: false, input: "hi" }
    const res = await app.request("/v1/responses", post(JSON.stringify(request), bearer()))
    expect(res.status).toBe(200)
    await res.text()
    await settle()
    expect(usage.rows).toHaveLength(1)
    expect(usage.rows[0]).toMatchObject({
      ...UNKNOWN_USAGE,
      egressMode: "passthrough",
      errorClass: "usage_unobservable",
    })
    const line = lines.find((entry) => entry.msg === "upstream usage unread")
    expect(line).toMatchObject({
      reason: "usage_unobservable",
      terminal: "none",
      lostTo: "trailing",
    })
    expect(line?.eventTypes).toMatchObject({
      "response.output_item.added": 1,
      "item.function_call": 1,
      "lost.response.completed": 1,
    })
  })
})
