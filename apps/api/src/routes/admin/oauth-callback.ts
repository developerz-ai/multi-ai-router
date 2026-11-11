import { Hono } from "hono"
import { type ConnectService, OAUTH_CALLBACK_PATH } from "../../services/accounts"
import type { AppEnv } from "../../types"
import { callbackPage } from "./auth-callback-page"

/**
 * The OAuth redirect capture: where a provider sends the operator's browser back with a `code`.
 *
 * **Unguarded, deliberately.** The redirect is a cross-site top-level navigation, so the admin
 * session cookie — `SameSite=Strict`, `__Host-` — is not sent with it, and a guard here would
 * refuse every real callback. The one-shot `state` is the authorization: 256 bits minted
 * server-side minutes earlier, bound to one Account row, redeemable once, and every rejection
 * worded identically so this cannot be probed (docs/idea/07-security.md#oauth-flow-safety).
 *
 * **Mounted at the root, at its published path**, because that is what `PUBLIC_URL` is documented
 * to be joined with (`.env.example`, docs/idea/09-deployment.md) — it is an address operators put
 * in a provider's console, not an internal one. The path constant comes from the service that
 * builds the authorization request, so the address served and the address requested cannot drift.
 *
 * The one route in this directory that answers HTML: a human lands here, having been bounced out
 * of a provider's consent screen, and the console is not necessarily where they came from. The
 * page is self-contained — no asset, no script, no token, and no interpolation that is not escaped.
 * One message quotes an Account label, which is operator input; `callbackPage` escapes it.
 */

export interface OAuthCallbackRoutesDeps {
  readonly connect: Pick<ConnectService, "redeem">
}

export function oauthCallbackRoutes(deps: OAuthCallbackRoutesDeps): Hono<AppEnv> {
  const routes = new Hono<AppEnv>()

  routes.get(OAUTH_CALLBACK_PATH, async (c) => {
    const result = await deps.connect.redeem({
      code: c.req.query("code"),
      state: c.req.query("state"),
      error: c.req.query("error"),
    })

    if (!result.ok)
      return c.html(callbackPage("Not connected", result.failure.message), result.failure.status)
    return c.html(callbackPage("Connected", "This account is authorized. You can close this tab."))
  })

  return routes
}
