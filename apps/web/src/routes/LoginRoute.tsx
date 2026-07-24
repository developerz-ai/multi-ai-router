import { useNavigate, useSearchParams } from "@solidjs/router"
import { createSignal, Show } from "solid-js"
import { Button } from "../components/Button"
import { TextField } from "../components/Field"
import { errorMessage } from "../lib/api/errors"
import { useLogin } from "../lib/queries/session"
import { safeNextPath } from "../lib/routes"
import styles from "./LoginRoute.module.scss"

/**
 * Rendered outside `AppLayout` — no nav, no chrome. A single admin, no user
 * table: the form posts credentials and the server sets a `__Host-` session
 * cookie plus a CSRF token the SPA holds in memory only.
 *
 * `?next=` carries the surface the operator was heading for when their session
 * expired, so a timeout returns them where they were rather than to the
 * dashboard. It is validated as a same-origin path before use: an open redirect
 * on a login form is how a phished operator ends up authenticating somewhere
 * else entirely.
 */
export default function LoginRoute() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const login = useLogin()

  const [username, setUsername] = createSignal("")
  const [password, setPassword] = createSignal("")

  const destination = () => safeNextPath(params.next)

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    login.mutate(
      { username: username(), password: password() },
      { onSuccess: () => navigate(destination(), { replace: true }) },
    )
  }

  return (
    <div class={styles.screen}>
      <div class={styles.card}>
        <div>
          <h1 class={styles.brand}>multi-ai-router</h1>
          <p class={styles.note}>Sign in to the admin console.</p>
        </div>

        <form class={styles.form} onSubmit={submit}>
          <TextField
            autocomplete="username"
            label="Username"
            name="username"
            onInput={(event) => setUsername(event.currentTarget.value)}
            required
            value={username()}
          />
          <TextField
            autocomplete="current-password"
            label="Password"
            name="password"
            onInput={(event) => setPassword(event.currentTarget.value)}
            required
            type="password"
            value={password()}
          />

          {/* `role="alert"`: the operator has just acted and is waiting on this. */}
          <Show when={login.isError}>
            <p class={styles.error} role="alert">
              {errorMessage(login.error)}
            </p>
          </Show>

          <Button busy={login.isPending} tone="primary" type="submit">
            Sign in
          </Button>
        </form>

        <p class={styles.note}>
          Failed attempts are throttled per username and per address, and audited server-side.
        </p>
      </div>
    </div>
  )
}
