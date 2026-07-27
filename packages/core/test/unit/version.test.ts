import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { UNKNOWN_REVISION, VERSION } from "../../src/version"

/**
 * `VERSION` is the source and every workspace manifest is a copy of it (`src/version.ts`), so the
 * one failure worth a test is drift: a release that bumps the manifests and forgets the constant
 * ships a router reporting the previous version from `/healthz`, `router_build_info`, the boot log
 * and the console footer, all at once and all agreeing with each other.
 *
 * The file read is the assertion, not a shortcut around one — the artifact under test *is* the
 * checked-in manifest, and there is nothing to inject in its place. Members are discovered from the
 * root `workspaces` globs rather than listed here, so a package added tomorrow is covered without
 * anyone remembering to add it.
 */

const manifest = z.object({
  name: z.string().optional(),
  version: z.string(),
  workspaces: z.array(z.string()).optional(),
})

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

function read(path: string): z.infer<typeof manifest> {
  return manifest.parse(JSON.parse(readFileSync(path, "utf8")))
}

/** Every manifest the package manager sees: the root, plus one per workspace member. */
function manifestPaths(): readonly string[] {
  const root = join(ROOT, "package.json")
  const members = (read(root).workspaces ?? []).flatMap((pattern) => {
    // Every glob this repo uses is `<dir>/*`. Anything fancier would need a matcher, and the
    // assertion below would rather fail loudly than quietly stop covering a package.
    expect(pattern).toEndWith("/*")
    const parent = join(ROOT, pattern.slice(0, -2))
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(parent, entry.name, "package.json"))
  })
  return [root, ...members]
}

describe("the version constant", () => {
  test("is a semver a container tag can carry, and never the unreleased placeholder", () => {
    // A pre-release suffix is allowed because the release pipeline supports rc tags
    // (docs/RELEASING.md#pre-releases) and the rc's router must say it is an rc rather than
    // impersonating the release it precedes. Build metadata (`+sha`) is not: `+` is illegal in a
    // container tag, so a version carrying one would produce an image nobody can name. That fact
    // belongs in `router_build_info{revision}`.
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/)
    expect(VERSION).not.toBe("0.0.0")
  })

  test("covers the root manifest and every workspace member", () => {
    const paths = manifestPaths()

    expect(paths.length).toBeGreaterThan(1)
    for (const path of paths) expect(read(path).version).toBe(VERSION)
  })

  test("has a revision sentinel that is not mistakable for a real one", () => {
    // `router_build_info{revision}` and the boot log fall back to this when nothing stamped the
    // build. It has to be obviously not a sha, or an operator reads it as one and chases a commit
    // that does not exist.
    expect(UNKNOWN_REVISION).toBe("unknown")
    expect(UNKNOWN_REVISION).not.toMatch(/^[0-9a-f]{7,}$/)
  })
})
