/**
 * A provider whose model listing is not the stock `GET {base}/models?limit=…` returning
 * `{data: [{id}]}` declares how to ask and how to read the answer here — on the driver, so the
 * listing service never names a provider (non-negotiable 12). Both members are pure.
 */
export interface ProviderModelListing {
  /** Query parameters the listing requires, sent instead of the stock page-size parameter. */
  query(): Readonly<Record<string, string>>
  /** Zod at the boundary: `null` for a shape this build cannot read, never a partial list. */
  read(body: unknown): readonly ListedModel[] | null
}

export interface ListedModel {
  readonly id: string
  readonly contextTokens: number | null
  readonly maxOutputTokens: number | null
}
