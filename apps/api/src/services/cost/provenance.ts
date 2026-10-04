/** Dates describe each source independently; inherited snapshots are not new verification. */
export interface PriceSource {
  readonly id: string
  readonly url: string
  readonly currency: "USD"
  readonly snapshotAsOf: string
  readonly verifiedAt: string | null
}
const inherited = (id: string, url: string): PriceSource => ({
  id,
  url,
  currency: "USD",
  snapshotAsOf: "2026-10-01",
  verifiedAt: null,
})
export const PRICE_SOURCES: readonly PriceSource[] = [
  inherited("anthropic", "https://platform.claude.com/docs/en/about-claude/pricing"),
  inherited("openai", "https://openai.com/api/pricing/"),
  inherited("google", "https://ai.google.dev/gemini-api/docs/pricing"),
  inherited("zai", "https://docs.z.ai/guides/overview/pricing"),
  inherited("minimax", "https://platform.minimax.io/docs/guides/pricing"),
  inherited("groq", "https://groq.com/pricing"),
  inherited("deepseek", "https://api-docs.deepseek.com/quick_start/pricing"),
  inherited("xai", "https://docs.x.ai/docs/models"),
  inherited("mistral", "https://mistral.ai/pricing"),
  inherited("together", "https://www.together.ai/pricing"),
  inherited("cerebras", "https://www.cerebras.ai/pricing"),
  {
    id: "kimi-coding-reference",
    url: "https://platform.kimi.ai/docs/pricing/chat",
    currency: "USD",
    snapshotAsOf: "2026-10-03",
    verifiedAt: "2026-10-03",
  },
]
export const KIMI_IDENTITY_SOURCE = "https://www.kimi.com/code/docs/en/"
