import { expect, test } from "bun:test"
import type { PriceOverrideRow } from "@multi-ai-router/db"
import {
  estimateCost,
  lookupRates,
  PRICE_SOURCES,
  PRICE_TABLE_AS_OF,
} from "../../../src/services/cost"
import { priceLookupForRows } from "../../../src/services/cost/book"
import { unpricedModels } from "../../../src/services/cost/coverage"
import { MINIMAX_UNPRICED } from "../../../src/services/cost/tables/minimax"

const accountId = "11111111-1111-4111-8111-111111111111"
const tokens = { tokensIn: 100, tokensOut: 10, cacheReadTokens: 0, cacheWriteTokens: 0 }
function row(model: string, input: number, account: string | null = null): PriceOverrideRow {
  return {
    id: crypto.randomUUID(),
    accountId: account,
    provider: "kimi",
    model,
    inputPerMtok: input,
    outputPerMtok: 2,
    cacheReadPerMtok: 0.1,
    cacheWritePerMtok: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  }
}

test("coding identity is explicit and never supplies a metered platform sibling price", () => {
  expect(lookupRates("kimi", "k3", { billing: "subscription" })?.inputPerMtok).toBe(3)
  expect(lookupRates("kimi", "k3-256k", { billing: "subscription" })?.inputPerMtok).toBe(3)
  expect(
    lookupRates("kimi", "kimi-for-coding-highspeed", { billing: "subscription" })?.inputPerMtok,
  ).toBe(1.9)
  for (const model of [
    "kimi-k3",
    "kimi-for-coding",
    "k2.8",
    "k3-preview",
    "k3-20261003",
    "unknown",
  ]) {
    expect(lookupRates("kimi", model, { billing: "subscription" })).toBeNull()
  }
  expect(lookupRates("kimi", "k3")).toBeNull()
  expect(lookupRates("kimi", "k3", { billing: "metered" })).toBeNull()
  expect(
    estimateCost({ provider: "kimi", model: "k3", tokens, billing: "subscription" }).costBasis,
  ).toBe("notional")
})

test("cache writes with unknown TTL remain unknown unless explicitly overridden", () => {
  const input = {
    provider: "kimi" as const,
    model: "k3",
    tokens: { ...tokens, cacheWriteTokens: 5 },
    billing: "subscription" as const,
  }
  expect(estimateCost(input)).toEqual({ costBasis: "unknown", costEstimate: null })
  expect(estimateCost({ ...input, prices: priceLookupForRows([row("k3", 9)]) }).costBasis).toBe(
    "notional",
  )
})

test("account family beats provider exact, another account cannot inherit it", () => {
  const lookup = priceLookupForRows([row("k3", 9, accountId), row("k3-20261003", 7), row("k3", 5)])
  expect(lookup("kimi", "k3-20261003", { accountId, billing: "metered" })?.inputPerMtok).toBe(9)
  expect(
    lookup("kimi", "k3-20261003", { accountId: "other", billing: "metered" })?.inputPerMtok,
  ).toBe(7)
  expect(lookup("kimi", "k3", { accountId: "other", billing: "metered" })?.inputPerMtok).toBe(5)
  expect(
    estimateCost({ accountId, provider: "kimi", model: "k3", tokens, prices: lookup }).costBasis,
  ).toBe("metered")
})

test("coverage uses account scope and retains unknown model catalog evidence", () => {
  const accounts = [
    {
      id: accountId,
      label: "Scoped",
      provider: "kimi" as const,
      billing: "metered" as const,
      models: ["k3", "k3"],
    },
    {
      id: "other",
      label: "Other",
      provider: "kimi" as const,
      billing: "metered" as const,
      models: ["k3"],
    },
    {
      id: "uncatalogued",
      label: "Unknown",
      provider: "kimi" as const,
      billing: "subscription" as const,
      models: [],
    },
  ]
  expect(unpricedModels(accounts, priceLookupForRows([row("k3", 9, accountId)]))).toEqual([
    { accountId: "other", provider: "kimi", model: "k3", reason: "missing_rate" },
    { accountId: "uncatalogued", provider: "kimi", model: null, reason: "unknown_model_catalog" },
  ])
  expect(PRICE_SOURCES.find((source) => source.id === "kimi-coding-reference")?.verifiedAt).toBe(
    "2026-10-03",
  )
  expect(PRICE_SOURCES.find((source) => source.id === "openai")?.verifiedAt).toBeNull()
})

test("displayed inherited snapshot is derived from the oldest source snapshot", () => {
  expect(PRICE_SOURCES.some((source) => source.snapshotAsOf === PRICE_TABLE_AS_OF)).toBe(true)
  for (const source of PRICE_SOURCES) expect(PRICE_TABLE_AS_OF <= source.snapshotAsOf).toBe(true)
})

test("MiniMax-M3.1-Flash-Preview has no vendor price, so it stays unknown (#254)", () => {
  // platform.minimax.io's public price list (docs/guides/pricing, read 2026-10-15) carries no row
  // for the preview: MiniMax serves it from the coding plan, and only resellers quote per-token
  // numbers. A reseller's figure is not the vendor's price, so the tokens price as unknown.
  expect(
    lookupRates("minimax", "MiniMax-M3.1-Flash-Preview", { billing: "subscription" }),
  ).toBeNull()
  expect(lookupRates("minimax", "MiniMax-M3.1-Flash-Preview", { billing: "metered" })).toBeNull()
  // A date pin must not fall back to a family row that does not price it either.
  expect(
    lookupRates("minimax", "MiniMax-M3.1-Flash-Preview-20261001", { billing: "subscription" }),
  ).toBeNull()
  expect(
    estimateCost({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash-Preview",
      tokens,
      billing: "subscription",
    }),
  ).toEqual({ costBasis: "unknown", costEstimate: null })
  // The registry is the documentation, so it cannot drift from the table: every entry names a
  // reason and still looks up null.
  expect(Object.keys(MINIMAX_UNPRICED)).toContain("minimax-m3.1-flash-preview")
  for (const [model, reason] of Object.entries(MINIMAX_UNPRICED)) {
    expect(reason.length).toBeGreaterThan(0)
    expect(lookupRates("minimax", model)).toBeNull()
  }
})

test("GPT-6 model coverage on openai-api and openai-oauth (#181)", () => {
  // The four ids were priced in #181; coverage must now report them as priced on both surfaces, and
  // must continue to report gpt-reserve / codex-auto-review as missing.
  const ids = ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "gpt-6-astra"]
  const apiAccounts = ids.map((model, index) => ({
    id: `api-${index}`,
    label: `api-${model}`,
    provider: "openai-api" as const,
    billing: "metered" as const,
    models: [model],
  }))
  expect(unpricedModels(apiAccounts, lookupRates)).toEqual([])
  const codexAccounts = ids.map((model, index) => ({
    id: `codex-${index}`,
    label: `codex-${model}`,
    provider: "openai-oauth" as const,
    billing: "subscription" as const,
    models: [model],
  }))
  expect(unpricedModels(codexAccounts, lookupRates)).toEqual([])

  // gpt-reserve and codex-auto-review still have no published price, so coverage flags them.
  const unpricedAccounts = [
    {
      id: "codex-r",
      label: "Codex reserve",
      provider: "openai-oauth" as const,
      billing: "subscription" as const,
      models: ["gpt-reserve", "codex-auto-review"],
    },
  ]
  expect(unpricedModels(unpricedAccounts, lookupRates)).toEqual([
    {
      accountId: "codex-r",
      provider: "openai-oauth",
      model: "gpt-reserve",
      reason: "missing_rate",
    },
    {
      accountId: "codex-r",
      provider: "openai-oauth",
      model: "codex-auto-review",
      reason: "missing_rate",
    },
  ])
})
