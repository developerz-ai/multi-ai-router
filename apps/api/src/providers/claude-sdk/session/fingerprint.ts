import { createHash } from "node:crypto"
import { FIRST_USER_TEXT_LIMIT } from "./conversation"

/**
 * The headerless client's session key: `sha256(clientCwd + "\n" + firstUserText[0:2000])[0:16]`,
 * **scoped by Account** (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Every part of that seed is load-bearing, and each was a bug somewhere before it was a rule:
 *
 * - **The working directory is in.** Unrelated projects routinely open with the same first message
 *   ("fix the failing test"), and without a cwd they would share one session and one another's
 *   context. We have no reliable cwd for a remote client, so it is an input this router usually
 *   supplies as `null` — honest, and the seam stays open for a client that does send one.
 * - **The system prompt is out.** It carries per-request file trees that change every turn, so
 *   including it would make the fingerprint change every turn and never match anything.
 * - **Only the first user message is in.** A conversation grows by appending; its opening does not
 *   move. Hashing the whole history would produce a new key per turn, which is the same failure.
 * - **The Account scopes it.** An SDK session id resumes only on the Account that created it, so a
 *   fingerprint shared across Accounts is both a guaranteed cache miss and one subscription's
 *   conversation reaching another's.
 *
 * This is *not* the router's HTTP session key (`services/dataplane/body/read.ts`), which is scoped
 * by API key and derived from the conversation's opening bytes without parsing them. That one names
 * the row; this one is the in-memory alias that finds an SDK session again when the client sends no
 * header and the byte-level key shifted underneath it.
 */

/** 16 hex characters — 64 bits. Collisions cost a wrongly-shared session, so this is not a name. */
const FINGERPRINT_HEX = 16

export interface FingerprintSeed {
  /** The Account the resulting session lives on. Scoping, not salt: it is not hashed. */
  readonly accountId: string
  /** The client's own working directory when it reported one. `null` for every remote client. */
  readonly clientCwd: string | null
  /** The conversation's opening user text, already capped at `FIRST_USER_TEXT_LIMIT`. */
  readonly firstUserText: string
}

export function sessionFingerprint(seed: FingerprintSeed): string {
  const digest = createHash("sha256")
    .update(
      `${seed.clientCwd ?? ""}\n${seed.firstUserText.slice(0, FIRST_USER_TEXT_LIMIT)}`,
      "utf8",
    )
    .digest("hex")
    .slice(0, FINGERPRINT_HEX)
  return scopedKey(seed.accountId, digest)
}

/**
 * Joins a scope to a key. The separator is written as an escape and never as a literal byte: a NUL
 * cannot appear in an account id, an HTTP header value, or a hex digest, so no pair of inputs can
 * spell another pair's key.
 */
export function scopedKey(scope: string, key: string): string {
  return `${scope}\u0000${key}`
}
