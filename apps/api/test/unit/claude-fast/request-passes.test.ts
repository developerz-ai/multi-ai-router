import { describe, expect, test } from "bun:test"
import { prepareFastRequest, readFastRequest } from "../../../src/providers/claude-fast/request"

/**
 * 101 finding 05.6: the fast request builder no longer stringifies the whole history for the
 * prompt id, copies only the message it mutates, and skips the `cache_control` walk when the raw
 * body never names it. These pin the behaviour those shortcuts must not change.
 */

const identity = {
  accessToken: "private-token",
  expiresAt: Date.now() + 3_600_000,
  deviceId: "a".repeat(64),
  accountUuid: "11111111-1111-4111-8111-111111111111",
}

function prepareText(raw: string) {
  const request = readFastRequest(Buffer.from(raw))
  const prepared = prepareFastRequest({
    request,
    model: "claude-opus-5-5",
    identity,
    accountId: "account",
    apiKeyId: "key",
    sessionKey: "session",
  })
  if (!prepared) throw new Error("refused")
  return { request, prepared, body: JSON.parse(prepared.text) as Record<string, unknown> }
}

const breakpoints = (body: Record<string, unknown>) =>
  (JSON.stringify(body).match(/"cache_control"/g) ?? []).length

describe("cache breakpoints", () => {
  test("a body without cache_control gets the router's breakpoints", () => {
    const { body } = prepareText(
      JSON.stringify({ max_tokens: 9, messages: [{ role: "user", content: "hi" }] }),
    )
    expect(breakpoints(body)).toBeGreaterThan(0)
  })

  test("a client breakpoint is respected, also when its key is spelled with an escape", () => {
    const own = { type: "text", text: "hi", cache_control: { type: "ephemeral" } }
    const plain = JSON.stringify({ max_tokens: 9, messages: [{ role: "user", content: [own] }] })
    expect(breakpoints(prepareText(plain).body)).toBe(1)
    const escaped = plain.replace('"cache_control"', '"cache\\u005fcontrol"')
    expect(escaped).not.toContain("cache_control")
    expect(breakpoints(prepareText(escaped).body)).toBe(1)
  })
})

describe("the parsed request is never mutated", () => {
  test("preparing twice from one parsed request gives the same body (the native retry)", () => {
    const raw = JSON.stringify({
      max_tokens: 9,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: [{ type: "text", text: "two" }] },
        { role: "user", content: [{ type: "text", text: "three" }] },
      ],
    })
    const { request, prepared } = prepareText(raw)
    const again = prepareFastRequest({
      request,
      model: "claude-opus-5-5",
      identity,
      accountId: "account",
      apiKeyId: "key",
      sessionKey: "session",
    })
    expect(again?.text).toBe(prepared.text)
    expect(JSON.stringify(request)).not.toContain("cache_control")
  })
})

describe("the generic prompt id", () => {
  const turn = (messages: unknown[]) =>
    prepareText(JSON.stringify({ max_tokens: 9, messages })).prepared.promptId

  test("is stable across the tool turns answering one prompt, and moves with the next prompt", () => {
    const prompt = { role: "user", content: "do it" }
    const call = {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
    }
    const result = {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    }
    const first = turn([prompt])
    expect(first).toBeDefined()
    expect(turn([prompt, call, result])).toBe(first)
    const next = turn([
      prompt,
      call,
      result,
      { role: "assistant", content: "done" },
      { role: "user", content: "again" },
    ])
    expect(next).not.toBe(first)
  })
})
