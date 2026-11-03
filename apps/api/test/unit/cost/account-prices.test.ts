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
    "2026-11-03",
  )
  expect(PRICE_SOURCES.find((source) => source.id === "openai")?.verifiedAt).toBe("2026-11-03")
})

test("displayed inherited snapshot is derived from the oldest source snapshot", () => {
  expect(PRICE_SOURCES.some((source) => source.snapshotAsOf === PRICE_TABLE_AS_OF)).toBe(true)
  for (const source of PRICE_SOURCES) expect(PRICE_TABLE_AS_OF <= source.snapshotAsOf).toBe(true)
})

test("glm-5.3 on zai carries the vendor's published rates (#253)", () => {
  // docs.z.ai/guides/overview/pricing, read 2026-10-15: GLM-5.3 input $1.4, output $4.4, cached
  // input $0.26 per Mtok, no cache-write price published. The #217 census saw this model served
  // with no shipped price, so its tokens recorded cost_basis = unknown until this row.
  const shipped = {
    inputPerMtok: 1.4,
    outputPerMtok: 4.4,
    cacheReadPerMtok: 0.26,
    cacheWritePerMtok: 0,
  }
  expect(lookupRates("zai", "glm-5.3", { billing: "subscription" })).toEqual(shipped)
  expect(lookupRates("zai", "glm-5.3")).toEqual(shipped)
  // A coding-plan account reports the same numbers as a notional attribution, not metered spend.
  expect(
    estimateCost({ provider: "zai", model: "glm-5.3", tokens, billing: "subscription" }),
  ).toEqual({ costBasis: "notional", costEstimate: "0.000184" })
  const zaiAccounts = [
    {
      id: "zai-coding",
      label: "Coding plan",
      provider: "zai" as const,
      billing: "subscription" as const,
      models: ["glm-5.3"],
    },
  ]
  expect(unpricedModels(zaiAccounts, lookupRates)).toEqual([])
})

test("the zai price source records the vendor-page verification", () => {
  // #256 read docs.z.ai/guides/overview/pricing on 2026-10-15 and priced glm-5.3 from that read;
  // the page was read again on 2026-11-03, which is the date the entry now carries. The entry must
  // not claim the inherited 2026-10-01 snapshot with verifiedAt: null — an inherited snapshot is
  // not a new verification, and this one has been re-verified.
  const zai = PRICE_SOURCES.find((source) => source.id === "zai")
  expect(zai?.url).toBe("https://docs.z.ai/guides/overview/pricing")
  expect(zai?.snapshotAsOf).toBe("2026-11-03")
  expect(zai?.verifiedAt).toBe("2026-11-03")
})

/**
 * The rule this pins: a source's verification date is the date its page was **actually read**.
 *
 * A source whose page was not re-read keeps `verifiedAt: null` and its inherited snapshot date —
 * and the two together are the statement "nobody looked". A source that claims a verification for
 * a page nobody opened is the one failure this whole mechanism exists to prevent: the console
 * would tell an operator their prices were checked on a date they were not.
 */
test("a source with no verification date means its rows were not re-checked", () => {
  for (const source of PRICE_SOURCES) {
    if (source.verifiedAt === null) {
      // Nothing was read, so the snapshot is the inherited one and says so.
      expect(source.snapshotAsOf, source.id).toBe("2026-10-01")
      continue
    }
    // A page was read: the snapshot and the verification share the date, and it is a real date.
    expect(source.snapshotAsOf, source.id).toBe(source.verifiedAt)
    expect(source.verifiedAt, source.id).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  }
})

test("every shipped table has a price source, and every source names a page", () => {
  // One source per shipped table: a table with no source is a table nobody can date, and a source
  // with no table is a date that promises nothing.
  expect(PRICE_SOURCES.length).toBe(12)
  for (const source of PRICE_SOURCES) {
    expect(source.id.length, source.id).toBeGreaterThan(0)
    expect(source.url.startsWith("https://"), source.id).toBe(true)
    expect(source.currency).toBe("USD")
  }
  // The wired tables and the sources agree, one for one.
  const ids = PRICE_SOURCES.map((source) => source.id).sort()
  expect(ids).toEqual([
    "anthropic",
    "cerebras",
    "deepseek",
    "google",
    "groq",
    "kimi-coding-reference",
    "minimax",
    "mistral",
    "openai",
    "together",
    "xai",
    "zai",
  ])
})

test("MiniMax-M3.1-Flash is now published, so it prices rather than staying unknown", () => {
  // platform.minimax.io's public price list (docs/pricing/overview, read 2026-11-03) carries a row
  // for MiniMax-M3.1-Flash: input $0.15, output $0.60, cached read $0.015 per Mtok. The preview
  // had no vendor price when #254 was written — only resellers quoted per-token numbers — so it
  // was left unpriced. The vendor has since published it, so it is priced now.
  expect(lookupRates("minimax", "MiniMax-M3.1-Flash", { billing: "metered" })).toEqual({
    inputPerMtok: 0.15,
    outputPerMtok: 0.6,
    cacheReadPerMtok: 0.015,
    cacheWritePerMtok: 0,
  })
  expect(
    estimateCost({
      provider: "minimax",
      model: "MiniMax-M3.1-Flash",
      tokens,
      billing: "metered",
    }),
  ).toEqual({ costBasis: "metered", costEstimate: "0.000021" })
})

test("the MiniMax M2 line left the price list, so it prices as unknown", () => {
  // The public price list (read 2026-11-03) carries MiniMax-M3 and MiniMax-M3.1-Flash only. A
  // retired id priced at its last known rate is a guess about a bill nobody is issuing.
  for (const model of ["minimax-m2.7", "minimax-m2.7-highspeed", "minimax-m2.5", "minimax-m2.1"]) {
    expect(lookupRates("minimax", model, { billing: "metered" }), model).toBeNull()
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
