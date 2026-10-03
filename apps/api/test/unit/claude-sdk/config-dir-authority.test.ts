import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAccountConfigDirs } from "../../../src/providers/claude-sdk/config-dir"

test("provision never follows or chmods a symlink account directory", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "router-dir-authority-"))
  const root = join(temporary, "accounts")
  const foreign = join(temporary, "foreign")
  await mkdir(root)
  await mkdir(foreign)
  await chmod(foreign, 0o755)
  const id = randomUUID()
  await symlink(foreign, join(root, id))
  const dirs = createAccountConfigDirs({ root, homeDir: null })
  try {
    await expect(dirs.provision(id)).rejects.toThrow()
    expect((await stat(foreign)).mode & 0o777).toBe(0o755)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})

test("provision refuses a symlink root component before creating a foreign account", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "router-root-authority-"))
  const foreign = join(temporary, "foreign")
  await mkdir(foreign)
  const root = join(temporary, "alias")
  await symlink(foreign, root)
  const id = randomUUID()
  const dirs = createAccountConfigDirs({ root, homeDir: null })
  try {
    await expect(dirs.provision(id)).rejects.toThrow()
    await expect(stat(join(foreign, id))).rejects.toThrow()
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
})
