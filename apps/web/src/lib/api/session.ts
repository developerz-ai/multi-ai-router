import { createSignal } from "solid-js"
import type { SessionView } from "./types"

// The two pieces of session state the *transport* needs, held outside the
// component tree because `request()` is not a component and must not have to be
// handed a token by every caller.
//
// The CSRF token is deliberately kept in memory only — never in
// `localStorage`, never in a cookie the SPA can read. It is minted server-side
// inside the session record (`services/admin-auth/csrf.ts`) and handed to the
// SPA in the login and session bodies; a reload re-reads it from
// `GET /api/admin/auth/session`, which is a cookie-authenticated call. Nothing
// here is a credential the SPA could leak by outliving the tab.
//
// `sessionLost` is the other half: a 401 from *any* endpoint means the cookie
// is gone or expired, and every surface must route to login rather than render
// a page full of error cards. One signal, one effect in `AppLayout`.

const [csrfToken, setCsrfToken] = createSignal<string | null>(null)
const [username, setUsername] = createSignal<string | null>(null)
const [sessionLost, setSessionLost] = createSignal(false)

export { csrfToken, sessionLost, username }

/** Login and session-refresh both land here. Clears any stale "lost" flag. */
export function adoptSession(session: SessionView): void {
  setCsrfToken(session.csrfToken)
  setUsername(session.username)
  setSessionLost(false)
}

/** A deliberate logout: no redirect flag, because the caller navigates itself. */
export function clearSession(): void {
  setCsrfToken(null)
  setUsername(null)
  setSessionLost(false)
}

/**
 * A 401 arrived. The token is worthless now, so it goes first — a mutation
 * racing this must not echo a token that belongs to a dead session.
 */
export function markSessionLost(): void {
  setCsrfToken(null)
  setUsername(null)
  setSessionLost(true)
}
