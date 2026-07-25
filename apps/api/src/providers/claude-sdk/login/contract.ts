/**
 * Logging a Claude subscription in, without ever holding its credential.
 *
 * **The `claude` CLI performs the login; the router only drives it.** The CLI mints the PKCE
 * `code_verifier` and the `state`, opens the authorization URL, exchanges the pasted code, and
 * writes `.credentials.json` into the Account's own `CLAUDE_CONFIG_DIR`. The router scrapes the URL
 * out of the CLI's output, hands it to the operator, and later writes the pasted `code#state` back
 * to the CLI's stdin. No subscription OAuth token is ever constructed, exchanged, transported, or
 * held here (CLAUDE.md non-negotiable 1, docs/idea/03-providers.md — *"takes the pasted `code#state`
 * back, then hands it to the CLI"*).
 *
 * That division is also the strongest form of the rule 07-security.md asks for. The `code_verifier`
 * is not merely kept server-side: it never exists on this side of the subprocess boundary at all,
 * so there is no field, no log, and no response that could carry it. What the router *does* own is
 * the `state` — read back out of the authorize URL's query — because one-shot, TTL-bounded,
 * bound-to-a-row are the checks nobody downstream performs for us.
 *
 * **Two calls, one subprocess.** The CLI is interactive by design: it prints a URL and blocks on
 * stdin. So a login spans two admin requests with a live subprocess between them, which is why this
 * is a handle rather than a function. The handle is in-memory and process-local by necessity — a
 * restart kills the subprocess, so a pending login genuinely dies with it, and pretending otherwise
 * by persisting a row would only produce a `state` no CLI is waiting for.
 *
 * The seam exists so `bin/test` never spawns a `claude` binary (CLAUDE.md testing rules): the
 * production implementation is `./spawn.ts`, and a test injects its own.
 */

/** Why a login could not be driven to completion. Each maps to one operator action. */
export type ClaudeLoginFailureKind =
  /** The `claude` binary could not be started at all. */
  | "cli_unavailable"
  /** The CLI ran but never printed an authorization URL before the handshake bound elapsed. */
  | "no_authorize_url"
  /** The URL carried no `state`, so the flow could not be bound to this account. */
  | "unbound_state"
  /** The CLI rejected the pasted code, or exited non-zero. */
  | "login_rejected"
  /** The CLI accepted the code but left no usable credential behind. */
  | "no_credential"
  /** The subprocess outlived its bound and was terminated. */
  | "timeout"

/**
 * A login that did not happen.
 *
 * Deliberately not a `RouterError`: every class in `packages/core` is a *data-plane* request
 * outcome with a fixed status, and this is an admin-plane rejection that `services/accounts/connect`
 * renders as an `AdminResult`. `message` is router-authored and safe to show an operator — the CLI's
 * own words never travel in it.
 */
export class ClaudeLoginError extends Error {
  readonly kind: ClaudeLoginFailureKind
  /**
   * A bounded tail of what the CLI printed, already run through the log redactor at the source.
   *
   * **For a log line only.** Without it a `no_authorize_url` is undebuggable — the CLI is the only
   * thing that knows why it did not print a URL. It is deliberately not part of `message`, so no
   * renderer can put it in a response by accident.
   */
  readonly logDetail: string | null

  constructor(kind: ClaudeLoginFailureKind, message: string, logDetail: string | null = null) {
    super(message)
    this.name = "ClaudeLoginError"
    this.kind = kind
    this.logDetail = logDetail
  }
}

/** A login in flight: the URL is out, the subprocess is waiting on the paste. */
export interface ClaudeLoginHandle {
  /**
   * The authorization URL the CLI printed, verbatim. Shown to the operator and opened by them —
   * the router neither builds it nor rewrites it.
   */
  readonly authorizeUrl: string
  /**
   * The `state` the CLI put in that URL. The router's only copy of it, and the value a paste is
   * checked against before anything is handed back to the CLI.
   */
  readonly state: string
  /**
   * Writes the pasted `code#state` to the CLI's stdin and waits for it to finish the exchange.
   *
   * Resolves only when the CLI exited successfully. Every other ending — a rejection, a crash, a
   * subprocess that hangs past its bound — is a {@link ClaudeLoginError}, and in all of them the
   * subprocess is already gone by the time it throws.
   */
  submit(codeAndState: string): Promise<void>
  /** Terminates the subprocess and releases it. Idempotent, and safe after {@link submit}. */
  cancel(): void
}

export interface ClaudeLoginStartInput {
  /** This Account's isolated `CLAUDE_CONFIG_DIR`, already provisioned. */
  readonly configDir: string
}

export interface ClaudeCliLogin {
  /**
   * Starts the CLI's login against `configDir` and resolves once it has printed a URL carrying a
   * `state`. Throws {@link ClaudeLoginError} otherwise, with nothing left running.
   */
  start(input: ClaudeLoginStartInput): Promise<ClaudeLoginHandle>
}
