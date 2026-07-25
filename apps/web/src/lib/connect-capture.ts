import { formatDuration } from "./reset-countdown"

/**
 * Reading what the operator is about to paste back, before it is sent.
 *
 * **Client-side pre-validation only.** The decision belongs to the server —
 * `services/accounts/connect/oauth-paste.ts` parses the value and every check that matters happens
 * there. This mirrors that module's acceptance so the dialog can say "that is not one of the three
 * shapes" *before* a one-shot login is spent on a paste that was always going to be refused. If the
 * two ever drift, nothing becomes unsafe; the console just teaches the wrong lesson, which is why
 * the shapes are enumerated here in the same order and with the same rules rather than guessed at.
 *
 * Pure: no DOM, and no clock. `connectExpiry` takes `nowMs`, so a countdown is testable against a
 * fixed instant and re-renders on the timer the caller already owns.
 *
 * **Nothing here ever returns any part of the pasted value.** It carries an authorization code, and
 * a "did you mean …?" that quotes it back would put that code into the DOM, into a tooltip, and
 * into whatever reads them.
 */

/** The three shapes an authorization page actually produces, plus the two non-answers. */
export type PastedShape = "callback-url" | "query-string" | "shorthand" | "unrecognised" | "empty"

export function classifyPaste(pasted: string): PastedShape {
  const trimmed = pasted.trim()
  if (trimmed === "") return "empty"

  // A `?` means a URL — the common case, because the address bar is where the value ends up when
  // the redirect has nowhere to land. Anything after `#` is the fragment, not a param.
  const marker = trimmed.indexOf("?")
  if (marker >= 0) {
    const query = trimmed.slice(marker + 1).split("#")[0] ?? ""
    return carriesPair(query) ? "callback-url" : "unrecognised"
  }
  if (trimmed.includes("=")) return carriesPair(trimmed) ? "query-string" : "unrecognised"

  // The shorthand, and nothing else in it: whitespace means a URL was pasted with a line break, or
  // two values were pasted together, and guessing which is how the wrong half gets exchanged.
  if (/\s/.test(trimmed)) return "unrecognised"
  const parts = trimmed.split("#")
  const [code, state] = parts
  if (parts.length !== 2 || code === undefined || state === undefined) return "unrecognised"
  return code === "" || state === "" ? "unrecognised" : "shorthand"
}

/** Both halves, both present, both non-empty. One missing is not a near-miss — it is not the pair. */
function carriesPair(query: string): boolean {
  const params = new URLSearchParams(query)
  const code = params.get("code")
  const state = params.get("state")
  return code !== null && state !== null && code !== "" && state !== ""
}

export function isSubmittablePaste(pasted: string): boolean {
  const shape = classifyPaste(pasted)
  return shape === "callback-url" || shape === "query-string" || shape === "shorthand"
}

/**
 * Keyed exhaustively rather than looked up in a plain object: a shape added above fails this build
 * instead of resolving to `undefined` — or, worse, to something inherited from `Object.prototype`.
 */
const SHAPE_SENTENCE: Readonly<Record<PastedShape, string>> = {
  "callback-url": "Looks like the whole callback URL — the usual case. Send it exactly as it is.",
  "query-string": "Looks like the callback query string, and it carries both halves.",
  shorthand: "Looks like the `code#state` shorthand.",
  unrecognised:
    "Not one of the accepted shapes. Paste the whole callback URL from the address bar, its query string, or the `code#state` shorthand — unedited, and on one line.",
  empty: "Paste whatever the authorization page left in the address bar.",
}

/** One operator-facing sentence per shape. Never quotes the value: it is an authorization code. */
export function describePasteShape(shape: PastedShape): string {
  return SHAPE_SENTENCE[shape]
}

export interface ConnectExpiry {
  readonly expired: boolean
  /** `"4m 30s"`. `"0s"` once the window is spent — never a negative countdown. */
  readonly remaining: string
}

/**
 * How long the one-shot start has left. An unparsable timestamp counts as expired: inviting a paste
 * into a login whose deadline cannot be read is worse than saying "start again".
 */
export function connectExpiry(expiresAtIso: string, nowMs: number): ConnectExpiry {
  const expiresAtMs = Date.parse(expiresAtIso)
  if (Number.isNaN(expiresAtMs)) return { expired: true, remaining: formatDuration(0) }

  const remainingMs = expiresAtMs - nowMs
  return { expired: remainingMs <= 0, remaining: formatDuration(remainingMs) }
}
