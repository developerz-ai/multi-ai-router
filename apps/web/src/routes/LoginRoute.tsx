import { useNavigate, useSearchParams } from "@solidjs/router"
import { createSignal, Show } from "solid-js"
import { Button } from "../components/Button"
import { TextField } from "../components/Field"
import { errorMessage } from "../lib/api/errors"
import { useAuthMethods, useLocalLogin } from "../lib/queries/session"
import { safeNextPath } from "../lib/routes"
import styles from "./LoginRoute.module.scss"

/**
 * Rendered outside `AppLayout` — no nav, no chrome. Which doors this page
 * offers is a server fact: `GET /api/admin/auth/methods` answers it, and the
 * page renders exactly that — the SSO button when OIDC is configured, the
 * password form when a local credential exists, both when both.
 *
 * The two flows differ in transport but land on the same session:
 *   - SSO navigates the browser away to the IdP and comes back through the
 *     callback with a cookie already set; `?error=` carries the callback's
 *     generic failure sentence back here.
 *   - The password form POSTs to `/api/admin/auth/login` and adopts the
 *     returned session, then navigates on. Its failure sentence is the same
 *     generic one, rendered inline where the operator typed.
 */
export default function LoginRoute() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const methods = useAuthMethods()
  const login = useLocalLogin()
  const [password, setPassword] = createSignal("")

  const destination = () => safeNextPath(params.next)
  const callbackError = () => {
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

  const submitPassword = (event: Event) => {
    event.preventDefault()
    if (password().length === 0 || login.isPending) return
    login.mutate(password(), {
      onSuccess: () => navigate(destination(), { replace: true }),
    })
  }

  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div>
          <h1 class={styles.brand}>multi-ai-router</h1>
          <p class={styles.note}>Sign in to the admin console.</p>
        </div>

        <Show when={callbackError() !== null}>
          <p class={styles.error} role="alert">
            {callbackError()}
          </p>
        </Show>

        <Show when={methods.isPending}>
          <p class={styles.note}>Checking how this router signs you in…</p>
        </Show>

        <Show when={methods.isError}>
          <p class={styles.error} role="alert">
            {errorMessage(methods.error)}
          </p>
        </Show>

        <Show when={methods.isSuccess && methods.data !== undefined}>
          <Show when={methods.data?.oidc === true}>
            <Button onClick={startOIDC} tone="primary" type="button">
              Sign in with SSO
            </Button>
          </Show>

          <Show when={methods.data?.oidc === true && methods.data.local === true}>
            <p class={styles.divider}>
              <span>or</span>
            </p>
          </Show>

          <Show when={methods.data?.local === true}>
            <form class={styles.form} onSubmit={submitPassword}>
              <TextField
                autocomplete="current-password"
                disabled={login.isPending}
                label="Password"
                name="password"
                onInput={(event) => setPassword(event.currentTarget.value)}
                required
                type="password"
                value={password()}
              />
              <Show when={login.isError}>
                <p class={styles.error} role="alert">
                  {errorMessage(login.error)}
                </p>
              </Show>
              <Button
                busy={login.isPending}
                disabled={password().length === 0}
                tone="primary"
                type="submit"
              >
                Sign in
              </Button>
            </form>
          </Show>

          <Show when={methods.data?.oidc === false && methods.data.local === false}>
            <p class={styles.error} role="alert">
              This router has no sign-in method configured. Set the ADMIN_OIDC_* variables, or run
              bin/admin set-password on the host, then reload.
            </p>
          </Show>
        </Show>

        <p class={styles.note}>
          Failed attempts are throttled per address and audited server-side.
        </p>
      </div>
    </div>
  )
}
