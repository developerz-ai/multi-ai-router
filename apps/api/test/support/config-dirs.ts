import {
  type AccountConfigDirs,
  type ConfigDirFs,
  createAccountConfigDirs,
} from "../../src/providers/claude-sdk/config-dir"

/**
 * Per-account config directories on a fake volume.
 *
 * The layout under test is real — same derivation, same guards — and only the three filesystem
 * calls are recorded instead of made, so a test can assert *which* directory an account got and
 * that it was created before the row and removed with it, without touching disk.
 *
 * `homeDir: null` because a fake volume cannot collide with this host's `~/.claude`; the guard that
 * refuses such a root is exercised directly in `test/unit/providers/config-dir.test.ts`.
 */
export interface MemoryConfigDirs {
  readonly dirs: AccountConfigDirs
  /** Path -> mode, as the directories currently on the fake volume. */
  readonly present: Map<string, number>
  /** Every call in order, as `"<verb> <path>"`. */
  readonly calls: string[]
}

export function createMemoryConfigDirs(root = "/data/claude"): MemoryConfigDirs {
  const present = new Map<string, number>()
  const calls: string[] = []

  const fs: ConfigDirFs = {
    makeDir: async (path, mode) => {
      calls.push(`mkdir ${path}`)
      if (!present.has(path)) present.set(path, mode)
    },
    setMode: async (path, mode) => {
      calls.push(`chmod ${path}`)
      present.set(path, mode)
    },
    removeDir: async (path) => {
      calls.push(`rm ${path}`)
      present.delete(path)
    },
  }

  return { dirs: createAccountConfigDirs({ root, homeDir: null, fs }), present, calls }
}
