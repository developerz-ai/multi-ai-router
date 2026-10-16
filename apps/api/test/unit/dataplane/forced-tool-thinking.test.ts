/**
 * `disableThinkingForForcedTool` (`services/dataplane/body/forced-tool-thinking.ts`).
 *
 * Prod fingerprint, 2026-10-15: developerz.ai's structured-output probe (`@ai-sdk/anthropic`
 * `generateObject`) sends `tool_choice {type: "any", disable_parallel_tool_use: true}` and no
 * `thinking` to MiniMax-M3, which thinks by default, ignores the force and answers `end_turn` prose.
 *
 * Prod regression, 2026-10-15..16 (v2.37.3): the same client, now stating a `thinking` budget beside
 * the forced tool (`thinking {type: "enabled"|"adaptive", budget_tokens}` + `tool_choice {type:
 * "tool", name: "json"}` / `{type: "any"}`), was answered with 538 router-made `400`s. The force is
 * the caller's contract and thinking is a dial: the dial yields, rewritten to `disabled`, rather
 * than the router refusing a request the vendor can serve.
 */
import { describe, expect, test } from "bun:test"
import { disableThinkingForForcedTool } from "../../../src/services/dataplane/body/forced-tool-thinking"

const enc = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const dec = (bytes: Uint8Array) =>
  JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
const base = { model: "MiniMax-M3", max_tokens: 9, messages: [], tools: [{ name: "json" }] }

describe("thinking enabled beside a forced tool is overridden to disabled, not refused", () => {
  // The prod regression, failure case first: the exact bytes that drew the 538 `400`s.
  for (const thinkingType of ["enabled", "adaptive"] as const) {
    test(`${thinkingType} + tool_choice {type: tool, name: json}`, () => {
      const out = disableThinkingForForcedTool(
        enc({
          ...base,
          thinking: { type: thinkingType, budget_tokens: 2048 },
          tool_choice: { type: "tool", name: "json" },
        }),
      )
      expect(dec(out).thinking).toEqual({ type: "disabled" })
      expect(dec(out).tool_choice).toEqual({ type: "tool", name: "json" })
      expect(dec(out).model).toBe("MiniMax-M3")
    })

    test(`${thinkingType} + tool_choice {type: any}`, () => {
      const out = disableThinkingForForcedTool(
        enc({
          ...base,
          thinking: { type: thinkingType, budget_tokens: 2048 },
          tool_choice: { type: "any" },
        }),
      )
      expect(dec(out).thinking).toEqual({ type: "disabled" })
      expect(dec(out).tool_choice).toEqual({ type: "any" })
    })
  }
})

describe("a forced tool choice with no thinking states thinking off", () => {
  test("any (the AI SDK generateObject shape)", () => {
    const out = disableThinkingForForcedTool(
      enc({ ...base, tool_choice: { type: "any", disable_parallel_tool_use: true } }),
    )
    expect(dec(out).thinking).toEqual({ type: "disabled" })
    expect(dec(out).tool_choice).toEqual({ type: "any", disable_parallel_tool_use: true })
    expect(dec(out).tools).toEqual(base.tools)
  })

  test("a named tool", () => {
    const out = disableThinkingForForcedTool(
      enc({ ...base, tool_choice: { type: "tool", name: "json" } }),
    )
    expect(dec(out).thinking).toEqual({ type: "disabled" })
  })

  test("a null thinking counts as absent", () => {
    const out = disableThinkingForForcedTool(
      enc({ ...base, thinking: null, tool_choice: { type: "any" } }),
    )
    expect(dec(out).thinking).toEqual({ type: "disabled" })
  })
})

describe("everything else is the client's own bytes", () => {
  const same = (body: unknown) => {
    const bytes = enc(body)
    expect(disableThinkingForForcedTool(bytes)).toBe(bytes)
  }

  test("auto, none and no tool_choice", () => {
    same({ ...base, tool_choice: { type: "auto" } })
    same({ ...base, tool_choice: { type: "none" } })
    same(base)
  })

  test("thinking already disabled", () => {
    same({ ...base, thinking: { type: "disabled" }, tool_choice: { type: "any" } })
  })

  test("a body that is not a JSON object is left for the upstream to judge", () => {
    const bytes = new TextEncoder().encode('"tool_choice" not json')
    expect(disableThinkingForForcedTool(bytes)).toBe(bytes)
    same([{ tool_choice: { type: "any" } }])
  })
})
