import { Hono } from "hono"
import { type ConnectService, OAUTH_CALLBACK_PATH } from "../../services/accounts"
import type { AppEnv } from "../../types"

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
      return c.html(page("Not connected", result.failure.message), result.failure.status)
    return c.html(page("Connected", "This account is authorized. You can close this tab."))
  })

  return routes
}

function page(title: string, detail: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
:root { color-scheme: dark light }
body { font: 16px/1.6 system-ui, sans-serif; margin: 0; display: grid; place-items: center; min-height: 100vh }
main { max-width: 34rem; padding: 2rem }
h1 { font-size: 1.25rem; margin: 0 0 .5rem }
p { margin: 0; opacity: .75 }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body>
</html>
`
}

/**
 * Every message rendered here is router-authored, but one of them quotes an Account label, which
 * is operator input. Escaping is what makes that inert rather than a judgement call per message.
 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
