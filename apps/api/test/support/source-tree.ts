import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Walk a source tree without following a directory through the same real path twice.
 *
 * Source inventory gates use this so a checked-in symlink cannot hide a file or recurse
 * indefinitely through one of its ancestors.
 */
export function walkFiles(directory: string, include: (path: string) => boolean): string[] {
  const visitedDirectories = new Set<string>()
  const files: string[] = []

  function visit(path: string): void {
    const stats = lstatSync(path)
    const target = stats.isSymbolicLink() ? realpathSync(path) : path
    const targetStats = stats.isSymbolicLink() ? statSync(target) : stats

    if (targetStats.isDirectory()) {
      const identity = realpathSync(target)
      if (visitedDirectories.has(identity)) return
      visitedDirectories.add(identity)
      for (const entry of readdirSync(target)) visit(join(target, entry))
      return
    }

    if (targetStats.isFile() && include(path)) files.push(path)
  }

  visit(directory)
  return files
}
