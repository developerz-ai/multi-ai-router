import type { AccountView } from "../../lib/api/types"

/**
 * Whether a redirect-captured login has landed, read off the account row — the only evidence this
 * tab gets, because the provider sends the browser to the router's callback and nothing is posted
 * back here.
 *
 * **`updatedAt` is not evidence.** Starting a login writes the row too (it records the pending
 * attempt), so "the row changed since the start" is true a moment after every start — which is how
 * the console once announced "Connected" over a login the server never exchanged. Only the fields
 * an exchange alone writes count: a credential appearing where there was none, or a `needs_reauth`
 * row that now holds a credential and is out of that state.
 *
 * A re-authorization of a row that was healthy and already held a credential has no field that
 * only the exchange moves (a routine refresh rotates `tokenExpiresAt` just the same), so it is
 * never inferred — the operator closes the dialog once the callback page says so, and the row is
 * the record. Saying nothing is the honest answer there; saying "connected" is not.
 */
export interface LoginBaseline {
  readonly hasCredential: boolean
  readonly status: AccountView["status"]
}

export function loginBaseline(row: Pick<AccountView, "hasCredential" | "status">): LoginBaseline {
  return { hasCredential: row.hasCredential, status: row.status }
}

export function redirectLanded(
  before: LoginBaseline,
  row: Pick<AccountView, "hasCredential" | "status">,
): boolean {
  if (!row.hasCredential) return false
  if (!before.hasCredential) return true
  return before.status === "needs_reauth" && row.status !== "needs_reauth"
}
