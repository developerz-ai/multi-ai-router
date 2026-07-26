import { chmod, lstat, mkdir, readdir, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"

/**
 * Where one Claude subscription Account's `CLAUDE_CONFIG_DIR` lives, and who creates it.
 *
 * The entire multi-account mechanism is this directory: point two `claude` subprocesses at two
 * directories and two subscriptions coexist in one container with no shared state
 * (docs/idea/11-anthropic-agent-sdk.md §3). The router never reads, decrypts, or refreshes what is
 * inside — it sets one environment variable and the SDK owns everything after that.
 *
 * **Keyed by Account id, never by label.** A label is the operator's disambiguator between five
 * near-identical subscriptions, and it is renameable; keying on it would mean a rename silently
 * orphans a logged-in directory and hands the account a fresh, logged-out one. The id is the row's
 * identity for its whole life, so the path is too — and `accounts_config_dir_key`
 * (packages/db/src/schema/accounts.ts) makes "two accounts, one directory" a write that cannot land.
 *
 * **Router-assigned, not operator-supplied.** Every path an operator could type is either this one
 * or a mistake, and one mistake is unrecoverable: `CLAUDE_CONFIG_DIR=$HOME/.claude`. Setting the
 * variable *even to the CLI's own default* changes the credential lookup key and breaks OAuth; the
 * only way to ask for the default is to leave it unset. We never want the default, so we never
 * unset it — every account gets an isolated directory under `CLAUDE_CONFIG_ROOT`, and a root that
 * would nest those directories inside the CLI's own config directory is refused at boot.
 *
 * `0700` because the contents are cleartext OAuth credentials the CLI owns. The uid that writes
 * them is the only one with any business reading them (docs/idea/07-security.md).
 */

/** The permissions a directory of live subscription credentials is allowed to carry. */
export const CONFIG_DIR_MODE = 0o700

/** The `claude` CLI's own config directory, relative to a home directory. */
const CLI_DEFAULT_DIR = ".claude"

/** Directories are named `<root>/<uuid>`; anything else is not an account id and not ours. */
const ACCOUNT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * A config-directory layout that cannot be honoured. Deliberately not a `RouterError`: those map to
 * an HTTP status, and both cases here are boot-or-bug — an operator-set `CLAUDE_CONFIG_ROOT` that
 * would break OAuth, or an id that did not come from the accounts table.
 */
export class ConfigDirError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConfigDirError"
  }
}

/**
 * One directory as it is on the volume right now — what a survey of the root sees, before anything
 * decides whether it still belongs to anyone.
 */
export interface ConfigDirEntry {
  /** The directory's name on disk, verbatim. Also the path's last segment. */
  readonly name: string
  /**
   * The account this directory is named after, or `null` when the name is not an account id at
   * all. A `null` here is the difference between "an account was deleted" and "this is not ours".
   */
  readonly accountId: string | null
  /** Newest of the directory's own mtime/ctime/birthtime, epoch ms. The most recent evidence of life. */
  readonly changedAtMs: number
}

export interface AccountConfigDirs {
  /** The root every account directory hangs off. Absolute, resolved once at construction. */
  readonly root: string
  /** The absolute directory this account's subprocess runs against. Pure — creates nothing. */
  pathFor(accountId: string): string
  /** `mkdir -p` at `0700`, returning the path. Idempotent: contents survive, permissions are re-asserted. */
  provision(accountId: string): Promise<string>
  /**
   * Removes the directory and everything the SDK put in it. Idempotent.
   *
   * Bounded to `<root>/<accountId>` by construction, which is why it takes an id and not the path
   * stored on the row: a directory this router did not mint is not this router's to `rm -rf`.
   */
  remove(accountId: string): Promise<void>
  /**
   * Every directory directly under `root`, classified and dated. Reads no file inside one — the
   * contents are the SDK's, and a reaper deciding what is abandoned only ever needs the name and
   * the age.
   *
   * A root that does not exist yet is an empty survey, not a failure: nothing has been provisioned,
   * so nothing can be orphaned. Symlinks are not entries — the sweep that follows one would be a
   * sweep outside the root.
   */
  list(): Promise<readonly ConfigDirEntry[]>
}

/** The filesystem as the five calls this module makes, so the policy is testable against no disk. */
export interface ConfigDirFs {
  makeDir(path: string, mode: number): Promise<void>
  setMode(path: string, mode: number): Promise<void>
  removeDir(path: string): Promise<void>
  /** Names of the plain directories directly under `path`. A missing `path` is `[]`, never a throw. */
  listDirs(path: string): Promise<readonly string[]>
  /** Newest of the directory's own timestamps, or `null` when it is gone or is not a plain directory. */
  statDir(path: string): Promise<number | null>
}

export interface AccountConfigDirsOptions {
  /** `CLAUDE_CONFIG_ROOT`, on the persistent volume. Must be absolute. */
  readonly root: string
  /** Defaults to this host's home directory. `null` skips the CLI-default collision check. */
  readonly homeDir?: string | null
  readonly fs?: ConfigDirFs
}

export function createAccountConfigDirs(options: AccountConfigDirsOptions): AccountConfigDirs {
  const home = options.homeDir === undefined ? safeHomeDir() : options.homeDir
  const root = usableRoot(options.root, home)
  const fs = options.fs ?? nodeConfigDirFs

  const pathFor = (accountId: string): string => {
    if (!ACCOUNT_ID.test(accountId)) {
      throw new ConfigDirError(
        `"${accountId}" is not an account id: a config directory is only ever named after one`,
      )
    }
    return join(root, accountId)
  }

  return {
    root,
    pathFor,

    provision: async (accountId) => {
      const dir = pathFor(accountId)
      await fs.makeDir(dir, CONFIG_DIR_MODE)
      // `mkdir` applies `mode` only to directories it creates, and the process umask can clear bits
      // from it. Re-asserting is what makes a re-provisioned or pre-existing directory safe.
      await fs.setMode(dir, CONFIG_DIR_MODE)
      return dir
    },

    remove: async (accountId) => {
      await fs.removeDir(pathFor(accountId))
    },

    list: async () => {
      const names = await fs.listDirs(root)
      const entries: ConfigDirEntry[] = []
      for (const name of names) {
        const changedAtMs = await fs.statDir(join(root, name))
        // Vanished between the listing and the stat — an account deleted mid-survey. Nothing to
        // report and nothing to reap.
        if (changedAtMs === null) continue
        entries.push({ name, accountId: ACCOUNT_ID.test(name) ? name : null, changedAtMs })
      }
      return entries
    },
  }
}

const nodeConfigDirFs: ConfigDirFs = {
  makeDir: async (path, mode) => {
    await mkdir(path, { recursive: true, mode })
  },
  setMode: (path, mode) => chmod(path, mode),
  removeDir: (path) => rm(path, { recursive: true, force: true }),

  listDirs: async (path) => {
    try {
      const entries = await readdir(path, { withFileTypes: true })
      // `isDirectory()` is false for a symlink even when it points at one, which is the property
      // wanted here: a link is never followed, so `remove` can never reach outside the root.
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch (error) {
      if (isMissing(error)) return []
      throw error
    }
  },

  statDir: async (path) => {
    try {
      // `lstat`, not `stat`: the entry was a directory when it was listed, and re-resolving a
      // symlink here would date whatever it points at instead of the thing about to be removed.
      const stats = await lstat(path)
      if (!stats.isDirectory()) return null
      // The newest of the three, because this number only ever delays a deletion: a directory
      // touched recently is one nothing may confidently call abandoned. `birthtimeMs` is 0 on
      // filesystems that do not record it, where it simply loses.
      return Math.max(stats.mtimeMs, stats.ctimeMs, stats.birthtimeMs)
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  },
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

function usableRoot(root: string, homeDir: string | null): string {
  if (!isAbsolute(root)) {
    throw new ConfigDirError(
      `CLAUDE_CONFIG_ROOT must be an absolute path, got "${root}": a relative root makes every account's credentials depend on the working directory`,
    )
  }
  const resolved = resolve(root)
  if (homeDir === null) return resolved

  const cliDefault = resolve(homeDir, CLI_DEFAULT_DIR)
  if (resolved === cliDefault || isInside(cliDefault, resolved)) {
    throw new ConfigDirError(
      `CLAUDE_CONFIG_ROOT must not be inside the claude CLI's own config directory (${cliDefault}): per-account directories are isolated from this host's Claude state, and a CLAUDE_CONFIG_DIR at or under the CLI default changes the credential lookup key and breaks OAuth`,
    )
  }
  return resolved
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel)
}

function safeHomeDir(): string | null {
  try {
    const home = homedir()
    return home.length > 0 ? home : null
  } catch {
    return null
  }
}
