import { describe, expect, test } from "bun:test"
import {
  CODEX_CLIENT_VERSION,
  codexModelListing,
} from "../../../src/providers/drivers/openai-oauth-models"

/**
 * The ChatGPT/Codex model listing's effort facts. Each row of `GET /backend-api/codex/models`
 * states `default_reasoning_level` and `supported_reasoning_levels` (openai/codex
 * `codex-rs/protocol/src/openai_models.rs` `ModelInfo`); before 2.72.0 the router read only the
 * slug and the windows, so `/v1/catalog` stated no levels for any ChatGPT model and a client fell
 * back to its own id table — which stopped at `xhigh`. Row shapes below are the bundled
 * `codex-rs/models-manager/models.json` entries (openai/codex main, 2026-11-20), trimmed.
 */

const levels = (...efforts: string[]) =>
  efforts.map((effort) => ({ effort, description: `${effort} effort` }))

describe("the Codex client version pin", () => {
  test("names a Codex CLI release that lists GPT-6.2 (minimal_client_version 0.166.0)", () => {
    expect(CODEX_CLIENT_VERSION).toBe("0.171.0")
    expect(codexModelListing.query()).toEqual({ client_version: "0.171.0" })
  })
})

describe("the Codex listing's reasoning levels", () => {
  test("states the levels in the listing's own order, the default, and `max`", () => {
    const listed = codexModelListing.read({
      models: [
        {
          slug: "gpt-6.2-sol",
          context_window: 272_000,
          default_reasoning_level: "low",
          supported_reasoning_levels: levels("low", "medium", "high", "xhigh", "max", "ultra"),
        },
      ],
    })
    expect(listed).toEqual([
      {
        id: "gpt-6.2-sol",
        contextTokens: 272_000,
        maxOutputTokens: null,
        reasoning: {
          supported: true,
          effort: ["low", "medium", "high", "xhigh", "max"],
          default: "low",
        },
      },
    ])
  })

  test("`ultra` and `persistent` are Codex UI aliases, never wire efforts, so they are not stated", () => {
    const [model] =
      codexModelListing.read({
        models: [
          {
            slug: "gpt-6-luna",
            default_reasoning_level: "ultra",
            supported_reasoning_levels: levels("low", "persistent", "max", "ultra"),
          },
        ],
      }) ?? []
    expect(model?.reasoning).toEqual({ supported: true, effort: ["low", "max"] })
  })

  test("a model stating no levels says nothing about thinking, rather than `supported: false`", () => {
    const listed = codexModelListing.read({
      models: [
        { slug: "a", supported_reasoning_levels: [] },
        { slug: "b" },
        { slug: "c", default_reasoning_level: "low" },
      ],
    })
    expect(listed?.map((model) => model.reasoning)).toEqual([undefined, undefined, undefined])
  })

  test("a reshaped level block costs that one fact, never the row or the listing", () => {
    const listed = codexModelListing.read({
      models: [
        { slug: "a", supported_reasoning_levels: "low" },
        { slug: "b", supported_reasoning_levels: [{ effort: 3 }], default_reasoning_level: 7 },
        { slug: "c", supported_reasoning_levels: levels("high"), default_reasoning_level: 7 },
      ],
    })
    expect(listed?.map((model) => model.id)).toEqual(["a", "b", "c"])
    expect(listed?.map((model) => model.reasoning)).toEqual([
      undefined,
      undefined,
      { supported: true, effort: ["high"] },
    ])
  })
})
