import { request } from "./client"
import { adoptSession, clearSession } from "./session"
import type { SessionView } from "./types"

// `/api/admin/auth`. The only group mounted outside the admin guard, because
// the OIDC start is what initiates the session the guard would otherwise
// require.
//
// The login itself runs entirely in the browser:
//   - the operator clicks "Sign in with OIDC" on `/login`
//   - the SPA navigates the browser to `/api/admin/auth/oidc/start`
//   - the API redirects to the IdP with PKCE + nonce
//   - the IdP returns the browser to `/api/admin/auth/oidc/callback`
//   - the API sets the session cookie and serves the SPA a small HTML page
//   - the SPA re-loads and `fetchSession()` reads the new cookie
//
// There is no `login()` here on purpose: the SPA does not POST credentials,
// so there is no body to put on the wire.

/**
 * Who am I, and is this cookie still worth anything. A 401 here is the normal
 * answer for a cold load with no cookie — `request` flips `sessionLost` and the
 * shell routes to the login screen.
 */
export async function fetchSession(): Promise<SessionView> {
  const session = await request<SessionView>({ method: "GET", path: "/auth/session" })
  adoptSession(session)
  return session
}

/**
 * Mutating, so it carries a CSRF token like any other action. The local state is
 * cleared whatever the server said: a logout that fails server-side must still
 * not leave a stale token in this tab.
 */
export async function logout(): Promise<void> {
  try {
    await request<{ readonly status: string }>({ method: "POST", path: "/auth/logout" })
  } finally {
    clearSession()
  }
}
