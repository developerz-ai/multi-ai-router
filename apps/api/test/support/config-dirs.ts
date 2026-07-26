import {
  type AccountConfigDirs,
  type ConfigDirFs,
  createAccountConfigDirs,
} from "../../src/providers/claude-sdk/config-dir"

/**
 * Per-account config directories on a fake volume.
 *
 * The layout under test is real — same derivation, same guards — and only the filesystem calls are
 * recorded instead of made, so a test can assert *which* directory an account got and that it was
 * created before the row and removed with it, without touching disk.
 *
 * The volume is flat: every directory is a direct child of the root, which is the only shape the
 * router ever creates. `place()` puts one there that no `provision` made — a crash leftover, or
 * something an operator dropped in — so the reaper can be tested against a volume that is not the
 * one this fixture would have produced by itself.
 *
 * `homeDir: null` because a fake volume cannot collide with this host's `~/.claude`; the guard that
 * refuses such a root is exercised directly in `test/unit/providers/config-dir.test.ts`.
 */
export interface MemoryConfigDirs {
  readonly dirs: AccountConfigDirs
  /** Path -> mode, as the directories currently on the fake volume. */
  readonly present: Map<string, number>
  /** Path -> newest timestamp, epoch ms. What `AccountConfigDirs.list()` reports as `changedAtMs`. */
  readonly changedAt: Map<string, number>
  /** Every call in order, as `"<verb> <path>"`. */
  readonly calls: string[]
  /** Puts a directory on the volume directly, bypassing `provision`. Returns its path. */
  place(name: string, changedAtMs: number, mode?: number): string
  /** Names currently on the volume, in insertion order. */
  names(): string[]
}

export function createMemoryConfigDirs(root = "/data/claude"): MemoryConfigDirs {
  const present = new Map<string, number>()
  const changedAt = new Map<string, number>()
  const calls: string[] = []
  const pathOf = (name: string): string => `${root}/${name}`

  const fs: ConfigDirFs = {
    makeDir: async (path, mode) => {
      calls.push(`mkdir ${path}`)
      if (!present.has(path)) present.set(path, mode)
      if (!changedAt.has(path)) changedAt.set(path, 0)
    },
    setMode: async (path, mode) => {
      calls.push(`chmod ${path}`)
      present.set(path, mode)
    },
    removeDir: async (path) => {
      calls.push(`rm ${path}`)
      present.delete(path)
      changedAt.delete(path)
    },
    listDirs: async (path) => {
      calls.push(`ls ${path}`)
      if (path !== root) return []
      return [...present.keys()].map((entry) => entry.slice(root.length + 1))
    },
    statDir: async (path) => {
      calls.push(`stat ${path}`)
      return present.has(path) ? (changedAt.get(path) ?? 0) : null
    },
  }

  return {
    dirs: createAccountConfigDirs({ root, homeDir: null, fs }),
    present,
    changedAt,
    calls,
    place: (name, changedAtMs, mode = 0o700) => {
      const path = pathOf(name)
      present.set(path, mode)
      changedAt.set(path, changedAtMs)
      return path
    },
    names: () => [...present.keys()].map((entry) => entry.slice(root.length + 1)),
  }
}
