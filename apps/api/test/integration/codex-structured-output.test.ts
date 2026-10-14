import { describe, expect, test } from "bun:test"
import { account } from "../unit/dataplane/fixtures"
import { bearer, CRYPTOR, harness, post, settle } from "./harness"

/**
 * `/v1/chat/completions` + `response_format` against a ChatGPT (Codex) account, end to end.
 *
 * Production, 2026-10-14 (`openai-oauth`, `gpt-6-luna`): the router answered its own `400
 * translation_failed` — "this build translates no structured-output constraint onto another
 * dialect" — while the same schema sent to `/v1/responses` as `text.format` returned
 * `{"title":"A Chat About Cats"}`. The constraint now travels as `text.format`, and the JSON comes
 * back as `message.content` unchanged, collected or streamed. The upstream is a mock.
 */

const ACCOUNT_ID = "acct-codex-123"
const ACCESS_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: ACCOUNT_ID } }),
).toString("base64url")}.sig`

function codexAccount() {
  return {
    ...account("codex", { provider: "openai-oauth", cipher: CRYPTOR, billing: "subscription" }),
    authMaterial: CRYPTOR.encrypt(JSON.stringify({ accessToken: ACCESS_TOKEN })),
  }
}

const ANSWER = '{"title":"A Chat About Cats"}'

const SCHEMA = {
  type: "object",
  properties: { title: { type: "string" } },
  required: ["title"],
  additionalProperties: false,
}

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: { name: "chat_title", strict: true, schema: SCHEMA },
}

function frame(type: string, fields: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`
}

/** A Codex stream whose one message item holds a single part of the given kind. */
function codexStream(
  part: { type: "output_text"; text: string } | { type: "refusal"; refusal: string },
) {
  return (): Response => {
    const text = part.type === "output_text" ? part.text : part.refusal
    const kind = part.type === "output_text" ? "output_text" : "refusal"
    const item = {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [part],
    }
    const body = [
      frame("response.created", { response: { id: "resp_1", status: "in_progress", output: [] } }),
      frame("response.output_item.added", {
        output_index: 0,
        item: { ...item, status: "in_progress", content: [] },
      }),
      frame(`response.${kind}.delta`, {
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: text,
      }),
      frame(`response.${kind}.done`, {
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        [kind === "output_text" ? "text" : "refusal"]: text,
      }),
      frame("response.output_item.done", { output_index: 0, item }),
      frame("response.completed", {
        response: {
          id: "resp_1",
          object: "response",
          status: "completed",
          model: "gpt-6-luna",
          output: [],
          usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
        },
      }),
    ].join("")
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  }
}

function chat(stream: boolean): string {
  return JSON.stringify({
    model: "gpt-6-luna",
    messages: [{ role: "user", content: "title this chat about cats" }],
    response_format: RESPONSE_FORMAT,
    ...(stream ? { stream: true } : {}),
  })
}

function sentBody(upstream: { calls: readonly { body: string | null }[] }) {
  return JSON.parse(upstream.calls[0]?.body ?? "{}") as Record<string, unknown>
}

type Delta = { content?: string; refusal?: string }

function deltas(sse: string): { deltas: Delta[]; finish: (string | null)[] } {
  const chunks = sse
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map(
      (line) =>
        JSON.parse(line.slice(6)) as { choices?: { delta: Delta; finish_reason: string | null }[] },
    )
  return {
    deltas: chunks.flatMap((chunk) => chunk.choices?.map((choice) => choice.delta) ?? []),
    finish: chunks.flatMap((chunk) => chunk.choices?.map((choice) => choice.finish_reason) ?? []),
  }
}

describe("openai-chat response_format against a Codex account", () => {
  test("non-stream: json_schema reaches the upstream as text.format; the JSON is message.content", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [codexStream({ type: "output_text", text: ANSWER })],
    })
    const res = await app.request("/v1/chat/completions", post(chat(false), bearer()))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      choices: { message: Record<string, unknown>; finish_reason: string }[]
    }

    expect(upstream.calls).toHaveLength(1)
    const sent = sentBody(upstream)
    expect(sent.text).toEqual({
      format: { type: "json_schema", name: "chat_title", strict: true, schema: SCHEMA },
    })
    expect("response_format" in sent).toBe(false)
    expect(sent.stream).toBe(true)

    expect(body.choices[0]?.message).toEqual({ role: "assistant", content: ANSWER })
    expect(JSON.parse(String(body.choices[0]?.message.content))).toEqual({
      title: "A Chat About Cats",
    })
    expect(body.choices[0]?.finish_reason).toBe("stop")

    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "success", egressMode: "translate" })
  })

  test("stream: the JSON arrives as delta.content, finish_reason stop", async () => {
    const { app } = harness({
      accounts: [codexAccount()],
      responses: [codexStream({ type: "output_text", text: ANSWER })],
    })
    const res = await app.request("/v1/chat/completions", post(chat(true), bearer()))
    expect(res.status).toBe(200)
    const { deltas: all, finish } = deltas(await res.text())
    expect(all.map((delta) => delta.content ?? "").join("")).toBe(ANSWER)
    expect(all.some((delta) => delta.refusal !== undefined)).toBe(false)
    expect(finish.filter((reason) => reason !== null)).toEqual(["stop"])
    await settle()
  })

  test("a refusal lands in message.refusal / delta.refusal, never inside content", async () => {
    const refused = codexStream({ type: "refusal", refusal: "I can't help with that." })
    const collected = harness({ accounts: [codexAccount()], responses: [refused] })
    const res = await collected.app.request("/v1/chat/completions", post(chat(false), bearer()))
    const body = (await res.json()) as {
      choices: { message: Record<string, unknown>; finish_reason: string }[]
    }
    expect(body.choices[0]?.message).toEqual({
      role: "assistant",
      content: null,
      refusal: "I can't help with that.",
    })
    expect(body.choices[0]?.finish_reason).toBe("stop")
    await settle()

    const streamed = harness({ accounts: [codexAccount()], responses: [refused] })
    const sse = await (
      await streamed.app.request("/v1/chat/completions", post(chat(true), bearer()))
    ).text()
    const { deltas: all } = deltas(sse)
    expect(all.map((delta) => delta.refusal ?? "").join("")).toBe("I can't help with that.")
    expect(all.map((delta) => delta.content ?? "").join("")).toBe("")
    await settle()
  })

  test("a malformed response_format is refused 400 before any upstream call", async () => {
    const { app, upstream, usage } = harness({
      accounts: [codexAccount()],
      responses: [codexStream({ type: "output_text", text: ANSWER })],
    })
    const res = await app.request(
      "/v1/chat/completions",
      post(
        JSON.stringify({
          model: "gpt-6-luna",
          messages: [{ role: "user", content: "hi" }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "bad name!", schema: SCHEMA },
          },
        }),
        bearer(),
      ),
    )
    const body = (await res.json()) as { error?: { code?: string; message?: string } }
    expect(res.status).toBe(400)
    expect(body.error?.code).toBe("translation_failed")
    expect(body.error?.message).toContain("response_format.json_schema.name")
    expect(body.error?.message).not.toContain("bad name")
    expect(upstream.calls).toHaveLength(0)
    await settle()
    expect(usage.rows[0]).toMatchObject({ outcome: "client_error" })
  })
})
