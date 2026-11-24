import type { ApiKeyView } from "./api/types"

export type KeyState = "active" | "expired" | "revoked"

/** What the router does with this key now: an expired one is refused exactly like a revoked one. */
export function keyState(key: Pick<ApiKeyView, "revoked" | "expiresAt">, nowMs: number): KeyState {
  if (key.revoked) return "revoked"
  return key.expiresAt !== null && Date.parse(key.expiresAt) <= nowMs ? "expired" : "active"
}
