import type { Dialect, ModelReasoning } from "@multi-ai-router/core"

/**
 * A provider whose model listing is not the stock `GET {base}/models?limit=…` returning
 * `{data: [{id}]}` declares how to ask and how to read the answer here — on the driver, so the
 * listing service never names a provider (non-negotiable 12). Both members are pure.
 */
export interface ProviderModelListing {
  /**
   * The surface whose listing to read, when it states more than the Account's own: OpenCode Go's
   * `/anthropic/v1/models` names ids only, while `/openai/v1/models` carries sizes and thinking modes
   * for the same models (prod 2026-11-07: both Go seats on the anthropic surface, 60 catalog rows,
   * no size and no `reasoning` on any). Absent: the Account's own surface.
   */
  readonly dialect?: Dialect
  /** Query parameters the listing requires, sent instead of the stock page-size parameter. */
  query(): Readonly<Record<string, string>>
  /** Zod at the boundary: `null` for a shape this build cannot read, never a partial list. */
  read(body: unknown): readonly ListedModel[] | null
}

export interface ListedModel {
  readonly id: string
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
  /** Thinking modes, for a listing that states them. Absent is unknown, never "does not think". */
  readonly reasoning?: ModelReasoning
}
