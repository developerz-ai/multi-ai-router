import { request } from "./client"
import type { ApiKeyView, DeletedView, MintedKey, RevealedKey } from "./types"

// `/api/admin/keys`. Request shapes mirror `services/keys/schemas.ts`.
//
// **Reveal is a POST, and that is not a mistake.** It is semantically a read
// and is audited as one, but it is the only endpoint in the system that returns
// a live credential, so it goes through the mutating path and carries a CSRF
// token — a GET that returns a secret is one `<img src>` away from being
// interesting to an attacker.
//
// There is no rotate endpoint and no shown-once flow to implement. Keys are
// stored encrypted, not hashed, and the operator can re-read one at any time.

export type KeyScopeInput =
  | { readonly kind: "all" }
  | { readonly kind: "pools"; readonly poolIds: readonly string[] }
  | { readonly kind: "accounts"; readonly accountIds: readonly string[] }

export interface RateLimitInput {
  readonly requests: number
  readonly windowSeconds: number
}

export interface CreateKeyInput {
  readonly name: string
  readonly scope?: KeyScopeInput
  readonly rateLimit?: RateLimitInput
  /** ISO-8601 with an offset. Must be in the future or the mint is refused. */
  readonly expiresAt?: string
}

export interface UpdateKeyInput {
  readonly name?: string
  readonly scope?: KeyScopeInput
  /** `null` removes the per-key ceiling. */
  readonly rateLimit?: RateLimitInput | null
  /** `null` makes the key non-expiring. */
  readonly expiresAt?: string | null
}

export function listKeys(): Promise<readonly ApiKeyView[]> {
  return request<readonly ApiKeyView[]>({ method: "GET", path: "/keys" })
}

export function getKey(id: string): Promise<ApiKeyView> {
  return request<ApiKeyView>({ method: "GET", path: `/keys/${id}` })
}

/** The mint is one of the two responses that carry the value. */
export function createKey(input: CreateKeyInput): Promise<MintedKey> {
  return request<MintedKey>({ method: "POST", path: "/keys", body: input })
}

export function updateKey(args: {
  readonly id: string
  readonly patch: UpdateKeyInput
}): Promise<ApiKeyView> {
  return request<ApiKeyView>({ method: "PATCH", path: `/keys/${args.id}`, body: args.patch })
}

/** The other one. Audited server-side before the value is handed over. */
export function revealKey(id: string): Promise<RevealedKey> {
  return request<RevealedKey>({ method: "POST", path: `/keys/${id}/reveal` })
}

/** One-way. 409s with `already_revoked` if the key is already dead. */
export function revokeKey(id: string): Promise<ApiKeyView> {
  return request<ApiKeyView>({ method: "POST", path: `/keys/${id}/revoke` })
}

export function deleteKey(id: string): Promise<DeletedView> {
  return request<DeletedView>({ method: "DELETE", path: `/keys/${id}` })
}
