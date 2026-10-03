import { constants } from "node:fs"
import { lstat, mkdir, open, realpath } from "node:fs/promises"
import { dirname, parse, resolve, sep } from "node:path"

/** Reject symlink components before provisioning; chmod only an opened directory inode. */
export async function makeAnchoredDirectory(path: string, mode: number): Promise<void> {
  const root = dirname(path)
  await makeAnchoredRoot(root, mode)
  await mkdir(path, { mode }).catch((error: unknown) => {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error
  })
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    if (!(await directory.stat()).isDirectory())
      throw new Error("credential directory is not anchored")
  } finally {
    await directory.close()
  }
}
export async function makeAnchoredRoot(root: string, mode: number): Promise<void> {
  let cursor = parse(root).root
  for (const segment of root.slice(cursor.length).split(sep).filter(Boolean)) {
    cursor = resolve(cursor, segment)
    try {
      const state = await lstat(cursor)
      if (!state.isDirectory() || state.isSymbolicLink())
        throw new Error("credential directory root is not anchored")
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")
        break
      throw error
    }
  }
  await mkdir(root, { recursive: true, mode })
  if ((await realpath(root)) !== root) throw new Error("credential directory root is not anchored")
}
export async function setDirectoryMode(path: string, mode: number): Promise<void> {
  if ((await realpath(dirname(path))) !== dirname(path))
    throw new Error("credential directory root is not anchored")
  const directory = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  try {
    await directory.chmod(mode)
  } finally {
    await directory.close()
  }
}
