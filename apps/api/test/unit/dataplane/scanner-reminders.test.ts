import { describe, expect, test } from "bun:test"
import { createRoutingScanner } from "../../../src/services/dataplane"

const encoder = new TextEncoder()

function prefixOf(content: unknown, chunkSize?: number): string {
  const bytes = encoder.encode(
    JSON.stringify({ model: "m", messages: [{ role: "user", content }] }),
  )
  const scanner = createRoutingScanner()
  const step = chunkSize ?? bytes.length
  for (let at = 0; at < bytes.length; at += step) scanner.push(bytes.subarray(at, at + step))
  const result = scanner.finish()
  expect(result.invalid).toBe(false)
  return new TextDecoder().decode(result.conversationPrefix)
}

// The shape Claude Code 2.1.292 opens every conversation with — the parent's and each subagent's —
// captured on a stub upstream: two reminder blocks shared across the CLI session, then the task.
const reminders = [
  {
    type: "text",
    text: `<system-reminder>\nAs you answer the user's questions, you can use the following context:\n# gitStatus\n${"x".repeat(1200)}\n</system-reminder>`,
  },
  {
    type: "text",
    text: `<system-reminder>\nAttribution for git commits and pull requests\n${"y".repeat(600)}\n</system-reminder>`,
  },
]
const opening = (task: string) => [...reminders, { type: "text", text: task }]

describe("the opening window skips <system-reminder> blocks", () => {
  test("a parent and its subagents no longer share one window", () => {
    // Before: the 1024-byte window held nothing but the shared reminder, so the parent and every
    // subagent of one Claude Code session resolved to one session key.
    const parent = prefixOf(opening("spawn three subagents"))
    const first = prefixOf(opening("Subtask 1: run echo sub1 then report."))
    const second = prefixOf(opening("Subtask 2: run echo sub2 then report."))

    expect(new Set([parent, first, second]).size).toBe(3)
    expect(first).toContain("Subtask 1")
    expect(first).not.toContain("system-reminder")
  })

  test("the window is identical however the body is chunked", () => {
    const whole = prefixOf(opening("Subtask 1"))
    for (const size of [1, 2, 7, 64, 1000]) expect(prefixOf(opening("Subtask 1"), size)).toBe(whole)
  })

  test("an opening with no reminder keeps its raw bytes", () => {
    const content = [{ type: "text", text: "hello" }]
    expect(prefixOf(content)).toBe(JSON.stringify({ role: "user", content }))
  })

  test("an opening that is nothing but reminders falls back to its raw bytes", () => {
    const raw = prefixOf(reminders)
    expect(raw).toContain("<system-reminder>")
    expect(raw.length).toBe(1024)
  })

  test("a reminder that is not a text block's leading text is kept", () => {
    const quoted = prefixOf([
      { type: "text", text: "explain <system-reminder> tags" },
      { type: "text", text: "please" },
    ])
    expect(quoted).toContain("explain <system-reminder> tags")
    const nested = prefixOf([
      {
        type: "tool_result",
        tool_use_id: "t",
        content: [{ type: "text", text: "<system-reminder>x" }],
      },
      { type: "text", text: "go" },
    ])
    expect(nested).toContain("tool_result")
  })
})
