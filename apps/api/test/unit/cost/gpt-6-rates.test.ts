/**
 * Independent recorded expectations: no production cards, helpers, or tier multipliers.
 *
 * **Mutation record (#197).** Every value this file pins was changed one at a time in
 * `apps/api/src/services/cost/tables/openai.ts` and the cost unit suite was re-run, so each pin is
 * known to fail when the shipped number moves. 33 mutations — the 32 rate fields (4 models ×
 * 2 tiers × 4 fields) and the shared `LONG_CONTEXT_FROM` threshold — and every one was caught.
 * The table was restored byte-for-byte afterwards and the unmutated cost suite is green: 90 pass,
 * 0 fail across 5 files.
 *
 * "rates card" is this file's test for that model, on both the `openai-api` and the `openai-oauth`
 * surface; "estimate" is a case in `estimate.test.ts`.
 *
 * | mutation | value | caught by |
 * |---|---|---|
| `gpt-6-luna` standard input | 0.1 → 0.2 | rates card: gpt-6-luna (both surfaces); estimate: gpt-6-luna 0.120000 |
| `gpt-6-luna` standard output | 0.5 → 1 | rates card: gpt-6-luna (both surfaces); estimate: gpt-6-luna 0.120000 |
| `gpt-6-luna` standard cacheRead | 0.01 → 0.02 | rates card: gpt-6-luna (both surfaces) |
| `gpt-6-luna` standard cacheWrite | 0.125 → 0.25 | rates card: gpt-6-luna (both surfaces) |
| `gpt-6-luna` long input | 0.2 → 0.4 | rates card: gpt-6-luna (both surfaces); estimate: gpt-6-luna 0.950000; estimate: gpt-6-luna 0.060000 |
| `gpt-6-luna` long output | 0.75 → 1.5 | rates card: gpt-6-luna (both surfaces); estimate: gpt-6-luna 0.950000 |
| `gpt-6-luna` long cacheRead | 0.02 → 0.04 | rates card: gpt-6-luna (both surfaces) |
| `gpt-6-luna` long cacheWrite | 0.25 → 0.5 | rates card: gpt-6-luna (both surfaces) |
| `gpt-6-sol` standard input | 2 → 4 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` standard output | 10 → 20 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` standard cacheRead | 0.2 → 0.4 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` standard cacheWrite | 2.5 → 5 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` long input | 4 → 8 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` long output | 15 → 30 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` long cacheRead | 0.4 → 0.8 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6-sol` long cacheWrite | 5 → 10 | rates card: gpt-6-sol (both surfaces) |
| `gpt-6.1-sol` standard input | 2 → 4 | rates card: gpt-6.1-sol (both surfaces); estimate: gpt-6.1-sol notional |
| `gpt-6.1-sol` standard output | 10 → 20 | rates card: gpt-6.1-sol (both surfaces); estimate: gpt-6.1-sol notional |
| `gpt-6.1-sol` standard cacheRead | 0.1 → 0.2 | rates card: gpt-6.1-sol (both surfaces); estimate: gpt-6.1-sol notional |
| `gpt-6.1-sol` standard cacheWrite | 2.5 → 5 | rates card: gpt-6.1-sol (both surfaces) |
| `gpt-6.1-sol` long input | 4 → 8 | rates card: gpt-6.1-sol (both surfaces) |
| `gpt-6.1-sol` long output | 15 → 30 | rates card: gpt-6.1-sol (both surfaces) |
| `gpt-6.1-sol` long cacheRead | 0.2 → 0.4 | rates card: gpt-6.1-sol (both surfaces) |
| `gpt-6.1-sol` long cacheWrite | 5 → 10 | rates card: gpt-6.1-sol (both surfaces) |
| `gpt-6-astra` standard input | 10 → 20 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` standard output | 50 → 100 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` standard cacheRead | 1 → 2 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` standard cacheWrite | 12.5 → 25 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` long input | 20 → 40 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` long output | 75 → 150 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` long cacheRead | 2 → 4 | rates card: gpt-6-astra (both surfaces) |
| `gpt-6-astra` long cacheWrite | 25 → 50 | rates card: gpt-6-astra (both surfaces) |
| `LONG_CONTEXT_FROM` threshold | 272_000 → 272_001 | rates card: gpt-6-astra (both surfaces); rates card: gpt-6-luna (both surfaces); rates card: gpt-6-sol (both surfaces); rates card: gpt-6.1-sol (both surfaces); estimate: threshold billing case; estimate: whole-prompt threshold case; estimate: tier listing case |
 *
 * Restored sha256: `433e919010e43b7ff2f562e95bd6cdc3dfb39b574b132aa14d14236e1b25acda` (unchanged).
 */

import { describe, expect, test } from "bun:test"
import { lookupRates } from "../../../src/services/cost"

for (const provider of ["openai-api", "openai-oauth"] as const) {
  describe(`${provider} GPT-6 recorded rates`, () => {
    test("gpt-6-luna standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-luna")).toEqual({
        inputPerMtok: 0.1,
        outputPerMtok: 0.5,
        cacheReadPerMtok: 0.01,
        cacheWritePerMtok: 0.125,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 0.2,
          outputPerMtok: 0.75,
          cacheReadPerMtok: 0.02,
          cacheWritePerMtok: 0.25,
        },
      })
    })

    test("gpt-6-sol standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-sol")).toEqual({
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheReadPerMtok: 0.2,
        cacheWritePerMtok: 2.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 4,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.4,
          cacheWritePerMtok: 5,
        },
      })
    })

    test("gpt-6.1-sol standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6.1-sol")).toEqual({
        inputPerMtok: 2,
        outputPerMtok: 10,
        cacheReadPerMtok: 0.1,
        cacheWritePerMtok: 2.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 4,
          outputPerMtok: 15,
          cacheReadPerMtok: 0.2,
          cacheWritePerMtok: 5,
        },
      })
    })

    test("gpt-6-astra standard and long-context cards", () => {
      expect(lookupRates(provider, "gpt-6-astra")).toEqual({
        inputPerMtok: 10,
        outputPerMtok: 50,
        cacheReadPerMtok: 1,
        cacheWritePerMtok: 12.5,
        longContext: {
          fromPromptTokens: 272_000,
          inputPerMtok: 20,
          outputPerMtok: 75,
          cacheReadPerMtok: 2,
          cacheWritePerMtok: 25,
        },
      })
    })
  })
}
