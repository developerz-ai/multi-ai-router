import { stat } from "node:fs/promises"
import { join } from "node:path"
import { CLI_REFRESH_LEAD_MS } from "../claude-sdk/credential-freshness"
import { UpstreamAdmissionRefused } from "../upstream-admission"
import type { FastCredential } from "./credential"

/**
 * The fast transport's credential, read under the metadata-owner fence only when it changed
 * (101 finding 05.2).
 *
 * The fenced read spawns the `config-owner` guardian plus `/bin/cat` and runs a four-step
 * handshake: 2.9 ms p50 / 13.6 ms max measured, all of it added time-to-first-token on the default
 * Claude path. The token itself only changes when the CLI rewrites `.credentials.json` — a refresh
 * inside the SDK fallback, or a re-login — so a warm request needs one `stat` of that file, never a
 * spawn. The key is the file's identity `(ino, size, mtimeNs)`: a rewrite in place moves mtime, a
 * rename-over moves the inode, and either forces the fenced re-read.
 *
 * What is not trusted to the key, and re-read instead: an entry whose expiry is inside the CLI's
 * own refresh lead (the invoker sends those to the SDK fallback anyway), a different `configDir`,
 * an Account {@link FastCredentialCache.forget} was called for (a `401`/`403` answer), and an
 * Account whose directory was revoked on delete. A `stat` that fails drops the entry and goes to the fenced read, which decides.
 *
 * The token lives in process memory only, beside the identity fields the request needs; nothing
 * here logs or returns it anywhere else. `stat` reads metadata, never content, and only of the
 * `configDir` the caller already validated for this Account.
 */
export interface FastCredentialCache {
  read(accountId: string, configDir: string): Promise<FastCredential | null>
  forget(accountId: string): void
}

export interface FastCredentialCacheDeps {
  /** The fenced read (`withMetadataOwner` → `readFastCredential`). Its refusals propagate. */
  readonly read: (accountId: string, configDir: string) => Promise<FastCredential | null>
  /** Injected in tests. Defaults to `stat` of `<configDir>/.credentials.json`. */
  readonly stamp?: (configDir: string) => Promise<string | null>
  readonly now?: () => number
  /**
   * `false` once the Account's directory is revoked (`AccountCliOwnership.isRevoked`): the entry
   * is dropped and the request refused before any read, as the fenced read itself refuses.
   */
  readonly admitted?: (accountId: string) => boolean
}

interface Entry {
  readonly configDir: string
  readonly stamp: string
  readonly credential: FastCredential
}

export function createFastCredentialCache(deps: FastCredentialCacheDeps): FastCredentialCache {
  const stampOf = deps.stamp ?? credentialFileStamp
  const now = deps.now ?? Date.now
  const entries = new Map<string, Entry>()
  return {
    async read(accountId, configDir) {
      if (deps.admitted?.(accountId) === false) {
        entries.delete(accountId)
        throw new UpstreamAdmissionRefused("credential directory revoked")
      }
      const stamp = await stampOf(configDir)
      const cached = entries.get(accountId)
      if (
        stamp !== null &&
        cached !== undefined &&
        cached.configDir === configDir &&
        cached.stamp === stamp &&
        cached.credential.expiresAt > now() + CLI_REFRESH_LEAD_MS
      )
        return cached.credential
      entries.delete(accountId)
      // Stamp taken before the read: a rewrite between the two stores new content under the old
      // stamp, and the next request's `stat` differs and re-reads. Never the other way round.
      const credential = await deps.read(accountId, configDir)
      if (credential !== null && stamp !== null)
        entries.set(accountId, { configDir, stamp, credential })
      return credential
    },
    forget(accountId) {
      entries.delete(accountId)
    },
  }
}

async function credentialFileStamp(configDir: string): Promise<string | null> {
  try {
    const info = await stat(join(configDir, ".credentials.json"), { bigint: true })
    return `${info.ino}:${info.size}:${info.mtimeNs}`
  } catch {
    // No path or errno is kept: the fenced read that follows reports what it finds.
    return null
  }
}
