import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * A tracked file is a public document: this repository is public. Two things
 * in it name somebody else, and this file holds both away.
 *
 * **A home directory.** The scrub and invoker fixtures held a verbatim capture
 * of a production client transcript, so the tree carried one person's home
 * directory — and the customer's repository inside it. A third party's path in
 * a public repository is a name and an address, published by a commit nobody
 * chose to publish it in. The fixture still needs a path to redact and a
 * working directory to carry; it does not need that one.
 *
 * **The customer's name.** A customer of this router is named in the source,
 * the console, the design documents, the changelog and the fixtures, with
 * their production measurements as the provenance of a behaviour. The
 * behaviour is worth keeping; the customer is not part of it. The name is
 * assembled from parts below, so this file never carries it in one piece —
 * and the trade is stated plainly: the name is in the repository's history
 * already, so a guard for it cannot be secret, and what it buys is that the
 * tree stops carrying it again.
 *
 * Git is the oracle for "tracked", invoked as a real `git ls-files`
 * subprocess, so the scope is the tree's own index and not a directory walk
 * that would also read a developer's untracked scratch file — the same reason
 * `audit-artifact-tracking.test.ts` asks git about its own ignore rules. A
 * wrong `ROOT` would narrow that scope silently, so the scope is pinned by a
 * sentinel before anything is scanned: a guard that reads a subtree and
 * passes is the failure this whole file exists to prevent.
 *
 * Two usernames are allowed, because the fixtures use them as their own
 * convention: `router` is the fixture home the neighbouring tests already use,
 * and `bun` is the runtime's, not a person's. This file spells out neither
 * spelling of a home root: it is tracked, and it is scanned like every other.
 *
 * `docs/plans/` is out of scope: those files are internal working documents
 * that are being taken out of the public tree under their own issue, and they
 * carry the operator's own path. When they go, this exclusion goes with them.
 *
 * The rules are functions, and the last describe block proves each one fires.
 * A guard that cannot fail is not a guard.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** This file's own path, repo-relative: the sentinel that pins the scope. */
const SELF = "apps/api/test/integration/public-tree.test.ts"

/** The usernames a tracked file may name: the fixtures' own convention. */
const PERMITTED_HOME_USERS = new Set(["router", "bun"])

/**
 * A home directory: the two spellings of a home root, each followed by a
 * username. The username is the path segment, so it ends at the next
 * separator — and a bare home path with no trailing separator is the same
 * rule, not an escape from it.
 */
const HOME_DIRECTORY = /\/(?:home|Users)\/([A-Za-z0-9._-]+)/gi

/**
 * The customer's name, assembled so this file never carries it in one piece.
 * The bare name is the rule: the domain form contains it, so one constant
 * covers both spellings the tree carried.
 */
const CUSTOMER_NAME = ["teso", "te"].join("")

/**
 * The paths the rule does not cover, and why.
 *
 * `docs/plans/` are internal working documents that are being taken out of the
 * public tree under developerz-ai/multi-ai-router#390, and they carry the
 * operator's own path. `.dz/` is the platform's own working directory: the
 * platform writes those files, so a guard that covered them would fail the
 * platform's own commits rather than a change made here — and the committed
 * brief names two private repositories on a line that tells the release lane
 * where to roll, so it cannot be edited without breaking that lane. The
 * carve-outs are prose until those files go, so they name the issue that
 * removes them: drop each entry together with its directory, and nothing here
 * fails on its own if that stalls.
 */
const EXCLUDED = [/^docs\/plans\//, /^\.dz\//]

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

/** The home directories in one text that the rule does not permit. */
function forbiddenHomes(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(HOME_DIRECTORY)) {
    const user = match[1] ?? ""
    if (!PERMITTED_HOME_USERS.has(user)) found.push(user)
  }
  return found
}

/** The customer's name in one text, in any case. */
function namesTheCustomer(text: string): boolean {
  return text.toLowerCase().includes(CUSTOMER_NAME.toLowerCase())
}

describe("the public tree", () => {
  test("no tracked file carries a home directory that is not the fixtures' convention", () => {
    const tracked = trackedFiles()
    // A wrong ROOT narrows `git ls-files` to a subtree, and the scan would
    // pass over a tree it never read. This file must always be in scope.
    expect(tracked).toContain(SELF)
    const offenders: string[] = []
    let read = 0
    for (const path of tracked) {
      if (EXCLUDED.some((pattern) => pattern.test(path))) continue
      const file = readText(path)
      if (!file.read) continue
      read += 1
      if (file.text === null) continue
      if (forbiddenHomes(file.text).length > 0) offenders.push(path)
    }
    expect(read, "the scan read no file at all").toBeGreaterThan(0)
    expect(
      offenders,
      `a tracked file carries a home directory (only ${[...PERMITTED_HOME_USERS].join(", ")} may be named): ${offenders.join(", ")}`,
    ).toEqual([])
  })

  test("no tracked file names the customer", () => {
    const tracked = trackedFiles()
    expect(tracked).toContain(SELF)
    const offenders: string[] = []
    let read = 0
    for (const path of tracked) {
      if (EXCLUDED.some((pattern) => pattern.test(path))) continue
      const file = readText(path)
      if (!file.read) continue
      read += 1
      if (file.text === null) continue
      if (namesTheCustomer(file.text)) offenders.push(path)
    }
    expect(read, "the scan read no file at all").toBeGreaterThan(0)
    expect(offenders, `a tracked file names the customer: ${offenders.join(", ")}`).toEqual([])
  })
})

describe("the guard itself", () => {
  test("the rule catches what it exists to catch, and lets the two conventions through", () => {
    // The fixtures are assembled from parts: this file is tracked and scanned
    // like every other, and a guard that spells out what it forbids trips on
    // itself.
    const person = "some" + "one"
    // A real person's home directory, in the shape the fixtures held — with a
    // trailing separator, and without one.
    expect(forbiddenHomes(`  Working directory: /home/${person}/workspace/some/repo`)).toHaveLength(
      1,
    )
    expect(forbiddenHomes(`  Working directory: /Users/${person}/workspace`)).toHaveLength(1)
    expect(forbiddenHomes(`  "home": "/Users/${person}"`)).toHaveLength(1)
    expect(forbiddenHomes(`  HOME=/home/${person}`)).toHaveLength(1)
    // The two conventions the fixtures use.
    expect(forbiddenHomes("  CLAUDE_CONFIG_DIR: /home/router/.claude")).toHaveLength(0)
    expect(forbiddenHomes("  path: /home/bun/.claude/local/claude")).toHaveLength(0)
    // And a path that is not a home directory at all.
    expect(forbiddenHomes("  server: http://router.internal/v1")).toHaveLength(0)
  })

  test("the customer rule catches the name in any case, and lets the rest through", () => {
    const name = CUSTOMER_NAME
    expect(namesTheCustomer(`provenance: ${name} production`)).toBe(true)
    expect(namesTheCustomer(`provenance: ${name.toUpperCase()} production`)).toBe(true)
    expect(namesTheCustomer("provenance: a customer deployment")).toBe(false)
    expect(namesTheCustomer("provenance: one customer deployment")).toBe(false)
  })
})
