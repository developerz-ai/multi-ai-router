import { rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

/**
 * The one thing the router checks about a credential file it does not own: that the `claude` CLI
 * can still read it.
 *
 * `.credentials.json` **must be compact**. The CLI's own parser treats a pretty-printed file as
 * *logged out* (docs/idea/11-anthropic-agent-sdk.md §3), which is the worst shape a bug can take
 * here — the login succeeded, the tokens are on disk and valid, and every request routed to the
 * Account fails as if nobody had ever connected it. A freshly written file from the CLI is already
 * compact; one restored from a backup, copied by a helpful script, or opened in an editor is not.
 *
 * So this settles the file after a login: absent means the login did not land, pretty-printed is
 * re-minified in place, and anything unparseable is reported rather than guessed at.
 *
 * **What it deliberately does not do.** It does not read a token, name a field, decrypt anything,
 * or return, log, or embed one byte of the file in an error. The re-minify path is the only one
 * that parses at all, the parsed value never leaves the function, and what comes back is a
 * four-value enum. The router remains a custodian of the directory and never a holder of the
 * credential (CLAUDE.md non-negotiable 1).
 */

/** The CLI's credential file, relative to a `CLAUDE_CONFIG_DIR`. */
export const CREDENTIALS_FILE = ".credentials.json"

/** Cleartext OAuth credentials. The uid that wrote them is the only one with business reading them. */
export const CREDENTIALS_MODE = 0o600

export type CredentialState =
  /** No credential file — the CLI exited without completing a login. */
  | "absent"
  /** Present and in the shape the CLI reads. Nothing was touched. */
  | "compact"
  /** Present but pretty-printed, which reads as logged out. Re-minified in place. */
  | "repaired"
  /** Present and not JSON. Left exactly as found; only a re-login can fix it. */
  | "unreadable"

/** The three filesystem calls this makes, so the policy is testable against no disk. */
export interface CredentialFs {
  /** The file's contents, or null when it does not exist. */
  read(path: string): Promise<string | null>
  /**
   * Writes `contents` to a sibling temp file at `mode` and renames it over `path`.
   *
   * Rename because the alternative is a torn write: a crash midway through overwriting a working
   * login leaves a truncated file, and a truncated credential file is an Account that has to be
   * connected again by a human.
   */
  replace(path: string, contents: string, mode: number): Promise<void>
}

export interface CredentialGuard {
  /** Reports — and where it can, repairs — the credential file in this Account's config directory. */
  settle(configDir: string): Promise<CredentialState>
}

export function createCredentialGuard(fs: CredentialFs = nodeCredentialFs): CredentialGuard {
  return {
    settle: async (configDir) => {
      const path = join(configDir, CREDENTIALS_FILE)
      const contents = await fs.read(path)
      if (contents === null || contents.trim().length === 0) return "absent"
      // The cheap check first, and it is the common one: a compact file is never parsed, so the
      // usual path holds no credential in memory at all.
      if (!isPretty(contents)) return "compact"

      const compact = minify(contents)
      if (compact === null) return "unreadable"
      await fs.replace(path, compact, CREDENTIALS_MODE)
      return "repaired"
    },
  }
}

/**
 * A compact `JSON.stringify` emits no newline; a pretty-printed one emits several. A single
 * trailing newline is a text-file convention, not indentation, so it does not count.
 */
function isPretty(contents: string): boolean {
  return contents.trimEnd().includes("\n")
}

/**
 * Round-trips through the parser and back, which is what removes the whitespace.
 *
 * Key order survives — `JSON.stringify` walks an object's own insertion order, and that is the
 * order `JSON.parse` built it in. Numeric precision survives too at the magnitudes in this file: an
 * `expiresAt` is milliseconds since the epoch, four orders of magnitude below the integer limit.
 */
function minify(contents: string): string | null {
  try {
    const parsed: unknown = JSON.parse(contents)
    // Never `${parsed}` and never a field name: the value is here only to be re-serialized.
    return JSON.stringify(parsed)
  } catch {
    return null
  }
}

const nodeCredentialFs: CredentialFs = {
  read: async (path) => {
    const file = Bun.file(path)
    return (await file.exists()) ? file.text() : null
  },
  replace: async (path, contents, mode) => {
    const staged = `${path}.tmp`
    await writeFile(staged, contents, { mode })
    try {
      await rename(staged, path)
    } catch (error) {
      await rm(staged, { force: true })
      throw error
    }
  },
}
