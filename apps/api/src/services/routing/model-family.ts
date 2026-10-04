/**
 * A provider's default answer to "is this a model you serve?", for an account whose operator
 * declared no `supportedModels`.
 *
 * Without it, "declares nothing" meant "serves everything" for every provider, and a key scoped to
 * a Claude subscription and a ChatGPT subscription routed `gpt-5.5` to Claude and `glm-5.3` to
 * ChatGPT — an upstream rejection where the right account sat in scope. A subscription serves one
 * vendor's names and nothing else, so its driver says which names those are; a generic endpoint
 * (OpenRouter, an OpenAI-compatible base URL) declares no family and keeps passthrough.
 *
 * It only ever **narrows** the candidate set. It never renames a model and never picks one
 * (non-negotiable 4), and an account's explicit `supportedModels` always replaces it.
 *
 * Patterns, not a list: a family admits next month's model without a release. Each pattern is
 * tested against the **upstream-side** name — after the account's alias map — which is the side
 * `supportedModels` is stated on too (`model.ts`).
 */
export interface ModelFamily {
  /**
   * A name is in the family when any pattern matches it. Anchor every pattern, and never set the
   * `g` or `y` flag: a stateful `RegExp` shared across requests answers differently on each call.
   */
  readonly patterns: readonly RegExp[]
}

export function inModelFamily(family: ModelFamily, model: string): boolean {
  return family.patterns.some((pattern) => pattern.test(model))
}
