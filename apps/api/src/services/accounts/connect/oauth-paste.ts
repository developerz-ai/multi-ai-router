/**
 * Reading what the operator pasted back — the manual capture mode, and the only one that works
 * with no reachable `PUBLIC_URL` (docs/idea/03-providers.md).
 *
 * Pure, and it decides nothing: a well-formed pair still faces every check the connect service
 * makes. This file exists only so "what did they paste" is answered in one place, with the shapes
 * an operator actually produces enumerated rather than guessed at per call site.
 */

/** The two values every capture mode ultimately delivers. */
export interface PresentedCode {
  readonly code: string
  readonly state: string
}

/**
 * Whatever shape the value arrived in: the whole callback URL (the common case — the address bar
 * is where the value ends up when the redirect has nowhere to land), a bare query string, or the
 * `code#state` shorthand the spec names. All three carry exactly the same two values, and refusing
 * two of them would only teach operators to hand-edit credential material before pasting it.
 */
export function parseAuthorizationPaste(pasted: string): PresentedCode | null {
  const trimmed = pasted.trim()
  if (trimmed === "") return null

  const query = queryOf(trimmed)
  if (query !== null) {
    const code = query.get("code")
    const state = query.get("state")
    return code === null || state === null || code === "" || state === "" ? null : { code, state }
  }

  // The shorthand, and nothing else in it: whitespace means a URL was pasted with a line break,
  // or two values were pasted together, and guessing which is how the wrong half gets exchanged.
  if (/\s/.test(trimmed)) return null
  const parts = trimmed.split("#")
  const [code, state] = parts
  if (parts.length !== 2 || code === undefined || state === undefined) return null
  return code === "" || state === "" ? null : { code, state }
}

/** A URL or a query string yields params; the `code#state` shorthand yields `null` and falls through. */
function queryOf(value: string): URLSearchParams | null {
  const marker = value.indexOf("?")
  if (marker >= 0) return new URLSearchParams(value.slice(marker + 1).split("#")[0] ?? "")
  return value.includes("=") ? new URLSearchParams(value) : null
}
