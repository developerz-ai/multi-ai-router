import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * A tracked file is a public document: this repository is public. A host on
 * our own domain in one is an internal address — the router this product
 * runs as, the MCP gateway, the database access gateway — published by a
 * commit nobody chose to publish it in.
 *
 * The defect this guards: the tracked MCP config named two internal service
 * endpoints, one of them the path by which an agent reaches a database, and a
 * provenance comment and a fixture named the production router's own address.
 * The platform stopped publishing that host in the review-bot footers and the
 * pull-request labels on 2026-11-10 (developerz.ai #8577, #8611); the source
 * still carried it.
 *
 * The two public hosts below are ours and public, and the product's own
 * documentation links to them. Every other host on the domain is an internal
 * service, and a reader of a public repository gains nothing from its address.
 *
 * Git is the oracle for "tracked", invoked as a real `git ls-files`
 * subprocess, so the scope is the tree's own index and not a directory walk
 * that would also read a developer's untracked scratch file — the same reason
 * `audit-artifact-tracking.test.ts` asks git about its own ignore rules.
 *
 * `docs/plans/` needed a carve-out while the internal plans lived in the
 * tree: they were removed from the public tree under
 * developerz-ai/multi-ai-router#390, and the exclusion went with them. Every
 * tracked file is now scanned.
 *
 * The rules are functions, and the last describe block proves each one fires.
 * A guard that cannot fail is not a guard.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** This file's own path, repo-relative: the sentinel that pins the scope. */
const SELF = "apps/api/test/integration/internal-hosts.test.ts"

/** The hosts on our own domain a tracked file may name: the public ones. */
const PERMITTED_OWN_HOSTS = new Set(["developerz.ai", "www.developerz.ai"])

/** Any host on our own domain. */
const OWN_HOST = /\b(?:[a-z0-9-]+\.)*developerz\.ai\b/gi

/**
 * The tracked files, from git's own index. A `git ls-files` that cannot run is
 * a broken oracle, not an empty tree: the rule would pass over a tree it never
 * read, which is the failure this whole file exists to prevent.
 */
function trackedFiles(): string[] {
  const top = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], { cwd: ROOT })
  if (top.exitCode !== 0) {
    const stderr = new TextDecoder().decode(top.stderr).trim()
    throw new Error(`git rev-parse --show-toplevel exited ${top.exitCode}: ${stderr}`)
  }
  const toplevel = new TextDecoder().decode(top.stdout).trim().replace(/\/+$/, "")
  const root = ROOT.replace(/\/+$/, "")
  if (toplevel !== root) {
    throw new Error(
      `git answers for ${toplevel}, not for ${root}: this checkout is inside another repository, so the scan would read a tree that is not ours`,
    )
  }
  const proc = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: ROOT })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new Error(`git ls-files exited ${proc.exitCode}: ${stderr}`)
  }
  return new TextDecoder()
    .decode(proc.stdout)
    .split("\0")
    .filter((path) => path.length > 0)
}

/** A file we cannot read as text carries no string for a reader to find. */
function readText(path: string): { text: string | null; read: boolean } {
  let bytes: Buffer
  try {
    bytes = readFileSync(`${ROOT}${path}`)
  } catch {
    return { text: null, read: false }
  }
  if (bytes.includes(0)) return { text: null, read: true }
  return { text: bytes.toString("utf8"), read: true }
}

/** The hosts on our own domain in one text that the rule does not permit. */
function forbiddenOwnHosts(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(OWN_HOST)) {
    if (!PERMITTED_OWN_HOSTS.has(match[0].toLowerCase())) found.push(match[0])
  }
  return found
}

describe("the public tree", () => {
  test("no tracked file names an internal host on our own domain", () => {
    const tracked = trackedFiles()
    // A wrong ROOT narrows `git ls-files` to a subtree, and the scan would
    // pass over a tree it never read. This file must always be in scope.
    expect(tracked).toContain(SELF)
    const offenders: string[] = []
    let read = 0
    for (const path of tracked) {
      const file = readText(path)
      if (!file.read) continue
      read += 1
      if (file.text === null) continue
      if (forbiddenOwnHosts(file.text).length > 0) offenders.push(path)
    }
    expect(read, "the scan read no file at all").toBeGreaterThan(0)
    expect(read, "the scan read no file at all").toBeGreaterThan(0)
    expect(
      offenders,
      `a tracked file names an internal host on our own domain (only ${[...PERMITTED_OWN_HOSTS].join(", ")} may be named): ${offenders.join(", ")}`,
    ).toEqual([])
  })
})

describe("the guard itself", () => {
  test("the rule catches what it exists to catch, and lets the public hosts through", () => {
    // The fixtures are assembled from parts: this file is tracked and scanned
    // like every other, and a guard that spells out what it forbids trips on
    // itself.
    const gateway = ["mcp", "developerz", "ai"].join(".")
    const dbGateway = ["db", "developerz", "ai"].join(".")
    const routerHost = ["router", "ai", "developerz", "ai"].join(".")
    // The shape the tracked config held: an internal service endpoint.
    expect(forbiddenOwnHosts(`"url": "https://${gateway}/v1/mcp"`)).toHaveLength(1)
    expect(forbiddenOwnHosts(`"url": "https://${dbGateway}/mcp"`)).toHaveLength(1)
    // The production router's own address, as a provenance comment carried it.
    expect(forbiddenOwnHosts(`measured against \`${routerHost}\``)).toHaveLength(1)
    // The public hosts, and a package scope that is not a host at all.
    expect(forbiddenOwnHosts("see https://developerz.ai/docs")).toHaveLength(0)
    expect(forbiddenOwnHosts("see https://www.developerz.ai/docs")).toHaveLength(0)
    expect(forbiddenOwnHosts('"@developerz.ai/ui-debugger-mcp"')).toHaveLength(0)
    // And a host that is not ours.
    expect(forbiddenOwnHosts("https://router.invalid/v1")).toHaveLength(0)
  })
})
