import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CREDENTIALS_FILE,
  CREDENTIALS_MODE,
  type CredentialFs,
  createCredentialGuard,
} from "../../../src/providers/claude-sdk/login"
import { nodeCredentialFs } from "../../../src/providers/claude-sdk/login/credentials"

/**
 * The compactness rule, which is the difference between a connected subscription and one that reads
 * as logged out (docs/idea/11-anthropic-agent-sdk.md §3).
 *
 * Every value here is a fabricated credential *shape* — the field names the CLI writes, with
 * obviously fake contents. Nothing in this file is a real token, and the assertions that matter
 * most are that the guard hands one back to nobody.
 */

const DIR = "/data/claude/8e0d3f4a-0000-4000-8000-00000000abcd"
const PATH = `${DIR}/${CREDENTIALS_FILE}`

const CREDENTIAL = {
  claudeAiOauth: {
    accessToken: "fake-access-not-a-real-token",
    refreshToken: "fake-refresh-not-a-real-token",
    expiresAt: 1_800_000_000_000,
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
  },
}

interface Disk {
  readonly fs: CredentialFs
  readonly files: Map<string, { contents: string; mode: number }>
}

function disk(seed?: string): Disk {
  const files = new Map<string, { contents: string; mode: number }>()
  if (seed !== undefined) files.set(PATH, { contents: seed, mode: 0o600 })
  return {
    files,
    fs: {
      read: async (path) => files.get(path)?.contents ?? null,
      replace: async (path, contents, mode) => {
        files.set(path, { contents, mode })
      },
    },
  }
}

describe("settling the credential file after a login", () => {
  test("leaves a compact file untouched", async () => {
    const compact = JSON.stringify(CREDENTIAL)
    const { fs, files } = disk(compact)

    expect(await createCredentialGuard(fs).settle(DIR)).toBe("compact")
    expect(files.get(PATH)?.contents).toBe(compact)
  })

  test("a trailing newline is a text convention, not indentation", async () => {
    const { fs } = disk(`${JSON.stringify(CREDENTIAL)}\n`)
    expect(await createCredentialGuard(fs).settle(DIR)).toBe("compact")
  })

  test("re-minifies a pretty-printed file, which the CLI reads as logged out", async () => {
    const { fs, files } = disk(JSON.stringify(CREDENTIAL, null, 2))

    expect(await createCredentialGuard(fs).settle(DIR)).toBe("repaired")
    const written = files.get(PATH)
    expect(written?.contents).toBe(JSON.stringify(CREDENTIAL))
    expect(written?.contents).not.toContain("\n")
    expect(written?.mode).toBe(CREDENTIALS_MODE)
  })

  test("re-minifying preserves every field and the millisecond expiry exactly", async () => {
    const { fs, files } = disk(JSON.stringify(CREDENTIAL, null, 4))
    await createCredentialGuard(fs).settle(DIR)

    expect(JSON.parse(files.get(PATH)?.contents ?? "null")).toEqual(CREDENTIAL)
  })

  test("a re-minified file settles as compact the second time", async () => {
    const { fs } = disk(JSON.stringify(CREDENTIAL, null, 2))
    const guard = createCredentialGuard(fs)

    expect(await guard.settle(DIR)).toBe("repaired")
    expect(await guard.settle(DIR)).toBe("compact")
  })

  test("reports an absent file rather than inventing a login", async () => {
    expect(await createCredentialGuard(disk().fs).settle(DIR)).toBe("absent")
    expect(await createCredentialGuard(disk("   \n").fs).settle(DIR)).toBe("absent")
  })

  test("leaves an unparseable file exactly as found", async () => {
    const broken = "{\n  not json at all\n}"
    const { fs, files } = disk(broken)

    expect(await createCredentialGuard(fs).settle(DIR)).toBe("unreadable")
    expect(files.get(PATH)?.contents).toBe(broken)
  })
})

describe("what the guard hands back", () => {
  /**
   * CLAUDE.md non-negotiable 1 and 3: the router is a custodian of the directory, never a holder of
   * the credential. The return type is a four-value enum for exactly this reason.
   */
  test("never returns credential material, on any path", async () => {
    const shapes = [
      JSON.stringify(CREDENTIAL),
      JSON.stringify(CREDENTIAL, null, 2),
      "{ broken",
      undefined,
    ]

    for (const shape of shapes) {
      const state = await createCredentialGuard(disk(shape).fs).settle(DIR)
      expect(["absent", "compact", "repaired", "unreadable"]).toContain(state)
      expect(state).not.toContain("fake-access")
      expect(state).not.toContain("fake-refresh")
    }
  })

  test("a write failure surfaces without quoting the file", async () => {
    const { fs } = disk(JSON.stringify(CREDENTIAL, null, 2))
    const guard = createCredentialGuard({
      read: fs.read,
      replace: async () => {
        throw new Error("EROFS: read-only file system")
      },
    })

    const thrown = await guard.settle(DIR).then(
      () => null,
      (error: unknown) => error,
    )
    expect(String(thrown)).not.toContain("fake-access")
    expect(String(thrown)).not.toContain("fake-refresh")
  })
})

/**
 * The atomicity guarantees live in `nodeCredentialFs`, so these exercise the real filesystem:
 * a fake `replace` that just overwrites the target cannot catch a collision or a leftover temp.
 */
describe("atomic replacement on disk", () => {
  const pretty = JSON.stringify(CREDENTIAL, null, 2)
  const compact = JSON.stringify(CREDENTIAL)

  async function configDir(): Promise<string> {
    return mkdtemp(join(tmpdir(), `router-credential-fs-${randomUUID()}-`))
  }

  async function entries(dir: string): Promise<string[]> {
    return readdir(dir)
  }

  test("concurrent settles in one directory never collide on a shared temp path", async () => {
    const dir = await configDir()
    try {
      const target = join(dir, CREDENTIALS_FILE)
      // Two writes racing with different content. Unique sibling temps mean one whole value wins;
      // a shared `.tmp` would let one call rename the other's bytes and leave a stray temp behind.
      const first = randomUUID().repeat(3)
      const second = randomUUID().repeat(4)
      await Promise.all([
        nodeCredentialFs.replace(target, first, CREDENTIALS_MODE),
        nodeCredentialFs.replace(target, second, CREDENTIALS_MODE),
      ])

      expect(await readFile(target, "utf8")).toBeOneOf([first, second])
      expect(await entries(dir)).toEqual([CREDENTIALS_FILE])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a rename rejection leaves no temp file and does not truncate the credential", async () => {
    const dir = await configDir()
    try {
      const target = join(dir, CREDENTIALS_FILE)
      await writeFile(target, compact, { mode: CREDENTIALS_MODE })
      // A directory where the target file should be makes `rename` fail with EISDIR/ENOTEMPTY.
      await rm(target)
      await mkdir(target)

      const thrown = await nodeCredentialFs.replace(target, pretty, CREDENTIALS_MODE).then(
        () => null,
        (error: unknown) => error,
      )
      expect(thrown).not.toBeNull()
      expect(await entries(dir)).toEqual([CREDENTIALS_FILE])
      expect(String(thrown)).not.toContain("fake-access")
      expect(String(thrown)).not.toContain("fake-refresh")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a write rejection leaves no temp file and the original credential intact", async () => {
    const dir = await configDir()
    try {
      const target = join(dir, CREDENTIALS_FILE)
      await writeFile(target, compact, { mode: CREDENTIALS_MODE })
      // Stage into a path whose parent does not exist: `writeFile` rejects before any rename.
      const missingDir = join(dir, "missing", CREDENTIALS_FILE)

      const thrown = await nodeCredentialFs.replace(missingDir, pretty, CREDENTIALS_MODE).then(
        () => null,
        (error: unknown) => error,
      )
      expect(thrown).not.toBeNull()
      expect(await entries(dir)).toEqual([CREDENTIALS_FILE])
      expect(await readFile(target, "utf8")).toBe(compact)
      expect(String(thrown)).not.toContain("fake-access")
      expect(String(thrown)).not.toContain("fake-refresh")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("a successful replace leaves only the credential, at the CLI's mode", async () => {
    const dir = await configDir()
    try {
      const target = join(dir, CREDENTIALS_FILE)
      await nodeCredentialFs.replace(target, compact, CREDENTIALS_MODE)

      expect(await entries(dir)).toEqual([CREDENTIALS_FILE])
      expect(await readFile(target, "utf8")).toBe(compact)
      expect((await stat(target)).mode & 0o777).toBe(CREDENTIALS_MODE)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
