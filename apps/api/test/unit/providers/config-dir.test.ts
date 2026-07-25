import { describe, expect, test } from "bun:test"
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONFIG_DIR_MODE,
  ConfigDirError,
  type ConfigDirFs,
  createAccountConfigDirs,
} from "../../../src/providers/claude-sdk/config-dir"

/**
 * The per-Account `CLAUDE_CONFIG_DIR` layout.
 *
 * Two properties carry the weight, and both are security properties rather than conveniences: one
 * account's subscription credentials never land in another account's directory, and no directory
 * this router mints can be the `claude` CLI's own — setting `CLAUDE_CONFIG_DIR` even to the CLI
 * default changes the credential lookup key and breaks OAuth
 * (docs/idea/11-anthropic-agent-sdk.md §3).
 *
 * Everything but the last block runs against an injected filesystem. The last block writes to a
 * temp directory, because "created `0700`" is a claim about a real inode and asserting it against
 * a fake would assert nothing.
 */

const ROOT = "/data/claude"
const ONE = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const TWO = "8ab4d2c1-6e39-4f70-b512-77c9e0a3d148"

function recorder(): { fs: ConfigDirFs; calls: string[]; modes: number[] } {
  const calls: string[] = []
  const modes: number[] = []
  return {
    calls,
    modes,
    fs: {
      makeDir: async (path, mode) => {
        calls.push(`mkdir ${path}`)
        modes.push(mode)
      },
      setMode: async (path, mode) => {
        calls.push(`chmod ${path}`)
        modes.push(mode)
      },
      removeDir: async (path) => {
        calls.push(`rm ${path}`)
      },
    },
  }
}

function dirs(fs: ConfigDirFs, root = ROOT) {
  return createAccountConfigDirs({ root, homeDir: null, fs })
}

describe("the path an account owns", () => {
  test("is the account id under the root, so two accounts are never one directory", () => {
    const layout = dirs(recorder().fs)
    expect(layout.pathFor(ONE)).toBe(`${ROOT}/${ONE}`)
    expect(layout.pathFor(TWO)).toBe(`${ROOT}/${TWO}`)
    expect(layout.pathFor(ONE)).not.toBe(layout.pathFor(TWO))
  })

  test("is refused for anything that is not an account id", () => {
    const layout = dirs(recorder().fs)
    for (const bad of ["", "..", "../../etc", "seb", `${ONE}/..`, ".claude"]) {
      expect(() => layout.pathFor(bad)).toThrow(ConfigDirError)
    }
  })

  test("the root is resolved once and reported", () => {
    expect(dirs(recorder().fs, "/data/claude/../claude").root).toBe(ROOT)
  })
})

describe("the roots that are refused at construction", () => {
  test("a relative root, which would make credentials depend on the working directory", () => {
    expect(() => dirs(recorder().fs, "data/claude")).toThrow(ConfigDirError)
    expect(() => dirs(recorder().fs, "./claude")).toThrow(ConfigDirError)
  })

  test("the claude CLI's own config directory, and anything under it", () => {
    const fs = recorder().fs
    const opts = (root: string) => ({ root, homeDir: "/home/router", fs })
    expect(() => createAccountConfigDirs(opts("/home/router/.claude"))).toThrow(ConfigDirError)
    expect(() => createAccountConfigDirs(opts("/home/router/.claude/accounts"))).toThrow(
      ConfigDirError,
    )
    // The message has to say why, or the operator reads it as an arbitrary restriction.
    expect(() => createAccountConfigDirs(opts("/home/router/.claude"))).toThrow(/OAuth/)
  })

  test("a sibling of the CLI's directory is fine — only nesting is the problem", () => {
    const fs = recorder().fs
    expect(
      createAccountConfigDirs({
        root: "/home/router/.claude-accounts",
        homeDir: "/home/router",
        fs,
      }).root,
    ).toBe("/home/router/.claude-accounts")
    expect(
      createAccountConfigDirs({ root: "/data/claude", homeDir: "/home/router", fs }).root,
    ).toBe(ROOT)
  })
})

describe("provisioning", () => {
  test("creates the directory and asserts its mode, in that order", async () => {
    const rec = recorder()
    const path = await dirs(rec.fs).provision(ONE)

    expect(path).toBe(`${ROOT}/${ONE}`)
    expect(rec.calls).toEqual([`mkdir ${ROOT}/${ONE}`, `chmod ${ROOT}/${ONE}`])
    // `mkdir` applies the mode only to what it creates, and the umask can clear bits from it.
    expect(rec.modes).toEqual([CONFIG_DIR_MODE, CONFIG_DIR_MODE])
  })

  test("is idempotent, so re-provisioning an existing account is not a way to lose a login", async () => {
    const rec = recorder()
    const layout = dirs(rec.fs)
    await layout.provision(ONE)
    await layout.provision(ONE)
    expect(rec.calls.filter((call) => call.startsWith("mkdir"))).toHaveLength(2)
  })

  test("removal names exactly the directory the router minted, never a stored path", async () => {
    const rec = recorder()
    await dirs(rec.fs).remove(ONE)
    expect(rec.calls).toEqual([`rm ${ROOT}/${ONE}`])
  })
})

describe("against a real filesystem", () => {
  test("the directory is 0700 and its contents go with it", async () => {
    const root = await mkdtemp(join(tmpdir(), "mar-config-dir-"))
    try {
      const layout = createAccountConfigDirs({ root, homeDir: null })
      const path = await layout.provision(ONE)

      // 0o777 masks off the file-type bits `stat` reports alongside the mode.
      expect((await stat(path)).mode & 0o777).toBe(CONFIG_DIR_MODE)

      // Stand in for what the CLI writes there. It must not survive the account.
      await writeFile(join(path, ".credentials.json"), "{}")
      await layout.remove(ONE)
      expect(await stat(path).catch(() => null)).toBeNull()

      // Idempotent: a directory that was never provisioned is already removed.
      await layout.remove(TWO)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("a directory left behind with looser permissions is tightened, not trusted", async () => {
    const root = await mkdtemp(join(tmpdir(), "mar-config-dir-"))
    try {
      const layout = createAccountConfigDirs({ root, homeDir: null })
      const path = await layout.provision(ONE)
      await chmod(path, 0o755)
      expect((await stat(path)).mode & 0o777).toBe(0o755)

      await layout.provision(ONE)
      expect((await stat(path)).mode & 0o777).toBe(CONFIG_DIR_MODE)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
