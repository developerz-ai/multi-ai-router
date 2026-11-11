import { type AccountSnapshot, resolveModel } from "../routing"

export interface ProbeModel {
  readonly model: string
  readonly source: "declared" | "provider-default"
}

/**
 * The first model the account itself declares (the operator's order), and the provider's default
 * only when it declares none: a shipped default goes stale when a vendor retires a model (prod
 * 2026-11-05: `MiniMax-M2`), while the declared list is what this account routes today.
 */
export function probeModel(
  account: AccountSnapshot,
  models: Readonly<Record<string, string>>,
): ProbeModel | undefined {
  const declared = account.supportedModels?.find((model) => resolveModel(account, model).supported)
  if (declared !== undefined) return { model: declared, source: "declared" }
  const fallback = models[account.provider]
  if (fallback !== undefined && resolveModel(account, fallback).supported)
    return { model: fallback, source: "provider-default" }
  return undefined
}
