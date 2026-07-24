import { Placeholder } from "../components/Placeholder"
import styles from "./LoginRoute.module.scss"

/**
 * Rendered outside `AppLayout` — no nav, no chrome. A single admin, no user
 * table: the form posts credentials and the server sets a session cookie.
 */
export default function LoginRoute() {
  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div>
          <h1 class={styles.brand}>multi-ai-router</h1>
          <p class={styles.note}>Sign in to the admin console.</p>
        </div>
        <Placeholder
          icon="keys"
          summary="Single-admin sign-in against ADMIN_USERNAME and the argon2id password hash."
          items={[
            "Username and password, posted to the admin auth endpoint",
            "Session cookie plus CSRF token; no credential is held in the SPA",
            "Failed attempts are rate limited server-side and audited",
            "Redirects back to the surface the operator was heading for",
          ]}
        />
      </div>
    </div>
  )
}
