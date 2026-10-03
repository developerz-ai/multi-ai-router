interface CallbackPageOptions {
  /**
   * Trusted markup appended inside `<main>`. Router-authored only — it is the one thing on this
   * page that does not go through {@link escapeHtml}, so nothing derived from the request may
   * reach it. `title` and `detail` are still escaped, and remain the only path anything external
   * could take.
   */
  readonly bodyExtra?: string
}

/** A self-contained HTML page. Mirrors the pattern in `oauth-callback.ts`. */
export function callbackPage(
  title: string,
  detail: string,
  options: CallbackPageOptions = {},
): string {
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
a { color: inherit }
</style>
</head>
<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>${options.bodyExtra ?? ""}</main></body>
</html>
`
}

/**
 * The success page, which exists only to leave itself: the browser navigated here from the IdP,
 * so landing on a dead end that says "you can close this tab" makes the operator finish the login
 * by hand. It sends them to the console instead.
 *
 * WHY A CLIENT-SIDE HOP AND NOT `c.redirect("/")`. The session cookie is `SameSite=Strict`, and
 * this request is the tail of a cross-site chain that began at the identity provider — the same
 * fact that makes this route deliberately unguarded (13-admin-oidc.md). A server-issued `302`
 * continues that chain, so the follow-up `GET /` can arrive *without* the cookie the response
 * just set, and the console bounces straight back to `/login` looking like the sign-in failed.
 * A navigation issued by this document is same-origin and self-initiated, which carries a Strict
 * cookie under any browser's reading of the rule.
 *
 * `location.replace` rather than `location.href`, so Back does not return to a consumed callback
 * URL — the state is one-shot, and re-entering it would render the generic failure to someone who
 * is in fact signed in. The link is the no-JS path and stays visible: a same-site click carries
 * the cookie exactly as the scripted hop does.
 */
export function callbackPageSignedIn(): string {
  return callbackPage("Signed in", "Returning you to the console…", {
    bodyExtra:
      `<p><a href="/">Continue to the console</a></p>` + `<script>location.replace("/")</script>`,
  })
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
}
