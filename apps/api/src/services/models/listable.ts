import type { ModelDescriptor } from "@multi-ai-router/core"
import { PROVIDER_REGISTRY } from "../../providers"
import { type AccountSnapshot, advertisedModels, resolveModel } from "../routing"
import { shippedSubscriptionModels } from "./subscription"

/**
 * What one Account contributes to `GET /v1/models`, as a pure function over its routing snapshot
 * and its catalog rows.
 *
 * The routing half is unchanged and authoritative: `advertisedModels` publishes the requested-side
 * names a request is actually served under, and an alias row carries what it resolves to — the
 * operator wrote `sonnet -> glm-4.7`, so the listing says so.
 *
 * The catalog half applies to **subscriptions only**, and the asymmetry is deliberate. An HTTP
 * passthrough account's discovered models stay on `/v1/catalog` and off `/v1/models`
 * (docs/idea/06-protocol-translation.md): the operator has a discover button to promote them into
 * `supportedModels` if that is what they mean. A Claude subscription has no such button and no HTTP
 * listing; the Agent SDK's handshake is its only voice, and a wire listing that ignored it would
 * answer `data: []` for a pool of six working subscriptions — which is the production bug this
 * exists to fix. The handshake's rows are unioned with the shipped table — the handshake names
 * what it resolves today (`sonnet -> claude-sonnet-5`, `opus[1m]`), the shipped table names the
 * family aliases and canonical ids a client may type — and a subscription the sweep has not reached
 * yet contributes the shipped table alone, so a freshly connected account lists models before its
 * first tick.
 *
 * Every catalog id is still admitted through `resolveModel(...).supported`, the same check
 * selection runs: an operator who did declare `supportedModels` on a subscription narrows what it
 * advertises exactly as they would on any other account.
 *
 * Resolution is **information only**. The client's model string goes upstream unchanged
 * (non-negotiable 4); `resolvedModel` tells a picker what `sonnet` means today, nothing more.
 *
 * Each name also carries the size its account's catalog states for it, so a client can learn the
 * real window from the listing it already reads. Looked up by the **upstream** id the name is sent
 * as first — `sonnet -> glm-4.7` is as big as `glm-4.7` — then by the name, then by what it resolves
 * to. Null is unknown, never a default: a client reading a missing window as unlimited builds a
 * request the upstream rejects.
 */

export interface ListedModel {
  /** Requested-side name: what a client sends. */
  readonly id: string
  /** What the name resolves to, when it is an alias — the account's map or the SDK's own word. */
  readonly resolvedModel: string | null
  /** Context window in tokens, from the account's catalog. Null when nothing states one. */
  readonly contextTokens: number | null
  /** Output ceiling in tokens, from the same row. Null when nothing states one. */
  readonly maxOutputTokens: number | null
}

export function listableModels(
  account: AccountSnapshot,
  catalogRows: readonly ModelDescriptor[],
): readonly ListedModel[] {
  const subscription = PROVIDER_REGISTRY[account.provider].transport === "agent-sdk"
  // Live rows first, so the subscription's own word on an alias wins; the shipped table then adds
  // the family aliases and canonical ids the handshake does not spell out (`opus`, `fable`,
  // `claude-opus-5`, …) — a client that types `--model opus` must find it listed, and a freshly
  // connected account lists models before its first sweep.
  const rows = subscription ? [...catalogRows, ...shippedSubscriptionModels()] : catalogRows
  const sizeOf = sizeLookup(account, rows)
  const listed = new Map<string, ListedModel>()

  for (const name of advertisedModels(account)) {
    const resolvedModel = aliasTarget(account, name)
    listed.set(name, { id: name, resolvedModel, ...sizeOf(name, resolvedModel) })
  }

  if (!subscription) return [...listed.values()]

  for (const row of rows) {
    if (listed.has(row.id) || !resolveModel(account, row.id).supported) continue
    const resolvedModel = row.resolvedModel ?? aliasTarget(account, row.id)
    listed.set(row.id, { id: row.id, resolvedModel, ...sizeOf(row.id, resolvedModel) })
  }
  return [...listed.values()]
}

type Size = Pick<ListedModel, "contextTokens" | "maxOutputTokens">

const UNKNOWN: Size = { contextTokens: null, maxOutputTokens: null }

/**
 * Case-insensitive, first row wins — the same keying the warm store uses, because the listing and
 * an alias map are written by different hands (`MiniMax-M2` vs `minimax-m2`). A row that states no
 * size is not indexed, so it cannot shadow a later spelling that does.
 */
function sizeLookup(
  account: AccountSnapshot,
  rows: readonly ModelDescriptor[],
): (name: string, resolvedModel: string | null) => Size {
  const byId = new Map<string, Size>()
  for (const row of rows) {
    const key = normalize(row.id)
    if (byId.has(key) || (row.contextTokens === null && row.maxOutputTokens === null)) continue
    byId.set(key, { contextTokens: row.contextTokens, maxOutputTokens: row.maxOutputTokens })
  }
  return (name, resolvedModel) =>
    byId.get(normalize(resolveModel(account, name).upstreamModel)) ??
    byId.get(normalize(name)) ??
    (resolvedModel === null ? undefined : byId.get(normalize(resolvedModel))) ??
    UNKNOWN
}

function normalize(id: string): string {
  return id.trim().toLowerCase()
}

/**
 * What a name resolves to under the presenting key: the first account's word wins, and a known
 * resolution beats an unknown one — two subscriptions agree on what `sonnet` is, and where one has
 * been swept and the other has not, the swept one is the one worth showing.
 */
export function mergeResolution(current: string | null, next: string | null): string | null {
  return current ?? next
}

function aliasTarget(account: AccountSnapshot, name: string): string | null {
  const resolution = resolveModel(account, name)
  return resolution.aliased ? resolution.upstreamModel : null
}
