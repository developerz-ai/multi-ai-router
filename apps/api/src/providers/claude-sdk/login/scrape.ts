/**
 * Everything about the `claude` CLI's login that is a *pinned fact about the CLI* rather than a
 * decision of ours, plus the pure functions that read its output.
 *
 * One file, by the same rule `providers/` follows everywhere else (CLAUDE.md non-negotiable 12): a
 * CLI release that renames the subcommand or reshapes the prompt changes this file and nothing
 * else. Each constant carries where the value came from and what breaks when it drifts, because
 * that is the only thing that makes a scraped interface maintainable.
 *
 * Kept apart from `./spawn.ts` so the scraping is a pure function of a string: no subprocess, no
 * temp directory, and no `claude` binary is needed to test the part most likely to break.
 */

/**
 * The subcommand that runs the CLI's own OAuth login against `CLAUDE_CONFIG_DIR`.
 *
 * *Provenance:* `claude auth login --help` on Claude Code 2.1.220 — the sibling of the
 * `claude auth status` probe docs/idea/11-anthropic-agent-sdk.md §3 pins. `--claudeai` selects the
 * Max/Pro subscription flow. It is the CLI's current default and is passed anyway: this router
 * connects subscriptions, and `--console` (API-key billing) is a different product reached through
 * a different provider entirely.
 *
 * *Blast radius:* connect and reconnect for every Claude subscription. Nothing else in the router
 * runs the CLI as a command — inference goes through the Agent SDK, which spawns its own. A CLI
 * that renames this is a one-line change here and a failing `cli_unavailable` until it is made.
 */
export const CLAUDE_LOGIN_ARGV: readonly string[] = Object.freeze(["auth", "login", "--claudeai"])

/**
 * Handed to the child on top of the isolated environment `../env.ts` builds.
 *
 * *Provenance:* the two variables every terminal program agrees on. Colour escapes are the reason —
 * an SGR-wrapped URL is a URL that does not parse.
 *
 * *Blast radius:* cosmetic only, and deliberately not relied on. Claude Code 2.1.220 emits the
 * authorization URL as an **OSC 8 hyperlink** even under `NO_COLOR`, which is why
 * {@link findAuthorizeUrl} strips escapes itself rather than trusting these to prevent them.
 */
export const LOGIN_ENV_OVERRIDES: Readonly<Record<string, string>> = Object.freeze({
  NO_COLOR: "1",
  FORCE_COLOR: "0",
})

/**
 * *Provenance:* observed output of `claude auth login --claudeai` on Claude Code 2.1.220, which
 * prints `https://claude.com/cai/oauth/authorize?…`. `claude.ai` and `console.anthropic.com` are
 * the hosts earlier builds and the `--console` flow use; all four are Anthropic's.
 *
 * *Blast radius:* a new host means `no_authorize_url` on every connect until it is added here. The
 * match is deliberately host-and-path only — query parameters are the CLI's business, and the URL
 * is handed to the operator byte for byte. The host list is closed on purpose: a bare
 * "any URL with /oauth/authorize in it" would let a line of CLI output redirect an operator
 * somewhere Anthropic does not control.
 */
const AUTHORIZE_URL =
  /https:\/\/(?:claude\.com|claude\.ai|platform\.claude\.com|console\.anthropic\.com)\/[\w./-]*oauth\/authorize\S*/

/**
 * SGR/CSI escapes, and OSC sequences — the second of which is not decoration. Claude Code wraps the
 * URL in an OSC 8 hyperlink, so the *target* copy is inside `ESC ] 8 ; ; … BEL` and the visible
 * copy follows it. Stripping the OSC removes the duplicate; leaving it in would concatenate the two
 * copies into one unparseable string.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching terminal escapes is the point
const ANSI = /\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)/g

/** Trailing punctuation a sentence puts after a URL and a URL never ends with. */
const TRAILING_NOISE = /[)\]}>.,;:'"]+$/

/**
 * The first authorization URL in a chunk of CLI output, or null while there is not one yet.
 *
 * Reads output, never stores it. The caller feeds accumulated stdout/stderr in and keeps only what
 * comes back — which matters because the same stream can carry credential material, and the URL is
 * the one part of it the router has any business retaining.
 */
export function findAuthorizeUrl(output: string): string | null {
  const match = AUTHORIZE_URL.exec(output.replace(ANSI, ""))
  if (match === null) return null
  const url = cutAtControl(match[0]).replace(TRAILING_NOISE, "")
  // A URL still being written arrives truncated; requiring a `state` is also what makes it whole.
  return readState(url) === null ? null : url
}

/**
 * Ends the match at the first control byte.
 *
 * A chunk boundary can land in the middle of an escape sequence, leaving one the stripper could not
 * recognise; without this the bytes ride along inside the `state` and bind the flow to a value the
 * operator will never paste back. In code rather than in the pattern, so no regex here carries a
 * literal control character.
 */
function cutAtControl(url: string): string {
  for (let i = 0; i < url.length; i += 1) {
    const code = url.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return url.slice(0, i)
  }
  return url
}

/**
 * The `state` the CLI put in its own authorize URL — the router's only handle on this flow.
 *
 * Null when the URL carries none, which is refused rather than worked around: an unbound flow has
 * no one-shot, no TTL, and no account to belong to (docs/idea/07-security.md#oauth-flow-safety).
 */
export function readState(authorizeUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(authorizeUrl)
  } catch {
    return null
  }
  const state = parsed.searchParams.get("state")
  return state === null || state.length === 0 ? null : state
}

/**
 * Splits the value the operator pastes back — the CLI's callback page renders the authorization
 * code and the state as `code#state`, and that whole string is what gets pasted.
 *
 * Null for anything that is not exactly two non-empty halves. A lenient parser here would mean
 * handing the CLI a code with a `#` still in it and reading its rejection as a bad login.
 */
export function parsePastedCode(pasted: string): { code: string; state: string } | null {
  const trimmed = pasted.trim()
  const hash = trimmed.indexOf("#")
  if (hash <= 0 || hash !== trimmed.lastIndexOf("#")) return null
  const code = trimmed.slice(0, hash)
  const state = trimmed.slice(hash + 1)
  return state.length === 0 ? null : { code, state }
}
