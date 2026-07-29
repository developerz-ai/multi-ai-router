import { useSearchParams } from "@solidjs/router"
import { Button } from "../components/Button"
import { errorMessage } from "../lib/api/errors"
import { safeNextPath } from "../lib/routes"
import styles from "./LoginRoute.module.scss"

/**
 * Rendered outside `AppLayout` — no nav, no chrome. The admin plane is now a
 * generic OIDC flow: the operator bounces off to the IdP, the IdP returns the
 * browser to `/api/admin/auth/oidc/callback`, the route mints a session and
 * serves the operator the SPA. This page is the only place in the router that
 * still renders any chrome around the login.
 *
 * `?error=` carries the message the callback page rendered when the IdP
 * declined the authorization. We display it inline, the same way the password
 * flow used to, so an operator who mistypes their IdP password lands back here
 * with the same flow.
 */
export default function LoginRoute() {
  const [params] = useSearchParams()

  const destination = () => safeNextPath(params.next)
  const error = () => {
    const value = params.error
    if (typeof value !== "string" || value.length === 0) return null
    return value
  }

  const startOIDC = () => {
    const next = destination()
    const url =
      next === "/"
        ? "/api/admin/auth/oidc/start"
        : `/api/admin/auth/oidc/start?next=${encodeURIComponent(next)}`
    window.location.assign(url)
  }

  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div>
          <h1 class={styles.brand}>multi-ai-router</h1>
          <p class={styles.note}>Sign in to the admin console.</p>
        </div>

        {/* The single button. The whole login is a redirect to the IdP. */}
        {error() !== null && (
          <p class={styles.error} role="alert">
            {errorMessage(Object.assign(new Error("error"), { message: error() }))}
          </p>
        )}

        <Button onClick={startOIDC} tone="primary" type="button">
          Sign in with SSO
        </Button>

        <p class={styles.note}>
          Failed attempts are throttled per address and audited server-side.
        </p>
      </div>
    </div>
  )
}
