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
 * unknown. Token columns stay 0 because no number was measured. Cost is NULL with basis `unknown`,
 * and `errorClass` names why, so a `GROUP BY` finds these rows.
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
  output_tokens_details: { reasoning_tokens: 0 },
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

async function drive(last: () => string) {
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
  const res = await app.request(
    "/v1/chat/completions",
    post(
      JSON.stringify({
        model: "gpt-5.6-terra",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
      bearer(),
    ),
  )
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
  tokensIn: 0,
  tokensOut: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costEstimate: null,
  costBasis: "unknown",
}

describe("a translated Codex success whose usage was never read", () => {
  test("a stream that ends without response.completed is recorded as unreported, not as free", async () => {
    const { row, lines } = await drive(() => "")
    expect(row).toMatchObject({ ...UNKNOWN_USAGE, errorClass: "usage_unreported" })
    const line = lines.find((entry) => entry.msg === "upstream usage unread")
    expect(line).toMatchObject({ reason: "usage_unreported", terminal: "none" })
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
      costBasis: "notional",
      errorClass: null,
    })
    expect(lines.some((entry) => entry.msg === "upstream usage unread")).toBe(false)
  })
})
