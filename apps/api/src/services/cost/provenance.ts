/**
 * Dates describe each source independently; an inherited snapshot is not a verification.
 *
 * `verifiedAt` is the date that source's page was **actually read**. A source whose page could not
 * be reached keeps `verifiedAt: null` and its inherited snapshot date, because claiming a
 * verification for a page nobody read is the one thing these two fields must never do.
 */
export interface PriceSource {
  readonly id: string
  readonly url: string
  readonly currency: "USD"
  readonly snapshotAsOf: string
  readonly verifiedAt: string | null
}

/**
 * A source whose page has not been re-read: the inherited snapshot date, and no verification.
 *
 * The shape a source takes when nobody read its page — a `verifiedAt: null` is not a missing
 * value, it is a statement that nobody looked, and it carries the inherited snapshot date beside
 * it so the row is not mistaken for a fresh one.
 *
 * No source in `PRICE_SOURCES` takes it today: every entry below was read on the date it names.
 * It stays exported because a page that cannot be reached tomorrow needs a shape to fall back to,
 * and a `verifiedAt: null` written by hand is exactly the kind of value that gets filled in later
 * by someone who read nothing.
 */
export const inherited = (id: string, url: string): PriceSource => ({
  id,
  url,
  currency: "USD",
  snapshotAsOf: "2026-10-01",
  verifiedAt: null,
})

/**
 * A source whose page was read on `read`: the snapshot and the verification share the date.
 */
const read = (id: string, url: string, on: string): PriceSource => ({
  id,
  url,
  currency: "USD",
  snapshotAsOf: on,
  verifiedAt: on,
})

export const PRICE_SOURCES: readonly PriceSource[] = [
  read("anthropic", "https://platform.claude.com/docs/en/about-claude/pricing", "2026-11-03"),
  read("openai", "https://developers.openai.com/api/docs/pricing", "2026-11-03"),
  read("google", "https://ai.google.dev/gemini-api/docs/pricing", "2026-11-03"),
  read("zai", "https://docs.z.ai/guides/overview/pricing", "2026-11-03"),
  read("minimax", "https://platform.minimax.io/docs/pricing/overview", "2026-11-03"),
  read("groq", "https://console.groq.com/docs/models", "2026-11-03"),
  read("deepseek", "https://api-docs.deepseek.com/quick_start/pricing", "2026-11-03"),
  read("xai", "https://docs.x.ai/docs/models", "2026-11-03"),
  read("mistral", "https://mistral.ai/pricing/api", "2026-11-03"),
  read("together", "https://docs.together.ai/docs/serverless/models", "2026-11-03"),
  read("cerebras", "https://www.cerebras.ai/pricing", "2026-11-03"),
  read("kimi-coding-reference", "https://platform.kimi.ai/docs/pricing/chat", "2026-11-03"),
]
export const KIMI_IDENTITY_SOURCE = "https://www.kimi.com/code/docs/en/"
