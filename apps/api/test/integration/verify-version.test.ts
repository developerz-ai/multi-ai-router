import { afterAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { VERSION } from "@multi-ai-router/core"

/**
 * Proves `bin/verify-version` is a gate and not a formality.
 *
 * It is the only thing standing between a tag push and a published image, because
 * `release.yml` builds and pushes — it never runs the test suite. The drift test that normally
 * holds `VERSION` and the manifests together (`packages/core/test/unit/version.test.ts`) therefore
 * does not gate a tag at all: cut `v1.0.1` from a tree where only the manifests moved and you
 * publish an image whose `/healthz`, `router_build_info`, boot log and console footer all say
 * `1.0.0`. The check this replaced compared the tag to the root `package.json` and would have
 * waved that through, which is the case asserted below by name.
 *
 * Real subprocesses against fixture trees on disk, for the same reason the database gate is tested
 * that way: the artifact under test is a shell script, and no in-process stand-in runs it.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..")
const SCRIPT = join(REPO_ROOT, "bin/verify-version")

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

interface Tree {
  /** The `VERSION` constant in `packages/core/src/version.ts`. */
  readonly constant: string
  /** Manifest version by path, root first. Anything omitted matches `constant`. */
  readonly manifests?: Readonly<Record<string, string>>
  /** Extra workspace members, discovered by the globs rather than named by the script. */
  readonly extraMembers?: readonly string[]
}

const BASE_MEMBERS = ["apps/api", "apps/web", "packages/core", "packages/db"] as const

async function write(root: string, path: string, contents: string): Promise<void> {
  const file = join(root, path)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, contents)
}

/** A miniature of this repo: the same workspace globs, one manifest per member, one constant. */
async function fixture(tree: Tree): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "router-verify-version-"))
  dirs.push(root)

  const members = [...BASE_MEMBERS, ...(tree.extraMembers ?? [])]
  const versionOf = (path: string): string => tree.manifests?.[path] ?? tree.constant

  await write(
    root,
    "package.json",
    JSON.stringify({
      name: "multi-ai-router",
      version: versionOf("package.json"),
      workspaces: ["apps/*", "packages/*"],
    }),
  )
  for (const member of members) {
    const path = `${member}/package.json`
    await write(root, path, JSON.stringify({ name: member, version: versionOf(path) }))
  }
  await write(
    root,
    "packages/core/src/version.ts",
    `/** doc comment quoting 9.9.9, which must not be matched */\nexport const VERSION = "${tree.constant}"\n`,
  )
  // The script resolves its own location, so it has to live where it would really live.
  await write(root, "bin/verify-version", await Bun.file(SCRIPT).text())
  await Bun.$`chmod +x ${join(root, "bin/verify-version")}`.quiet()
  return root
}

interface Ran {
  readonly output: string
  readonly exitCode: number
}

async function verify(root: string, ...args: string[]): Promise<Ran> {
  const child = Bun.spawn([join(root, "bin/verify-version"), ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { output: stdout + stderr, exitCode: await child.exited }
}

describe("bin/verify-version", () => {
  test("passes on this repo, for its own version, tagged and untagged", async () => {
    // The assertion that matters most: whatever the fixtures below prove, the gate has to be
    // green on the tree it actually guards, or the next tag push fails for the wrong reason.
    expect((await verify(REPO_ROOT)).exitCode).toBe(0)
    expect((await verify(REPO_ROOT, `v${VERSION}`)).exitCode).toBe(0)
  })

  test("refuses a tag that does not name the version the code reports", async () => {
    const root = await fixture({ constant: "1.0.0" })

    const ran = await verify(root, "v1.0.1")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("v1.0.1")
    expect(ran.output).toContain("1.0.0")
  })

  test("refuses the tag the old package.json-only check would have published", async () => {
    // Every manifest bumped, the constant forgotten. `jq -r .version package.json` agrees with the
    // tag and the image ships reporting the previous version from five surfaces at once.
    const root = await fixture({
      constant: "1.0.0",
      manifests: {
        "package.json": "1.0.1",
        "apps/api/package.json": "1.0.1",
        "apps/web/package.json": "1.0.1",
        "packages/core/package.json": "1.0.1",
        "packages/db/package.json": "1.0.1",
      },
    })

    const ran = await verify(root, "v1.0.1")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("packages/core/src/version.ts")
  })

  test("names the one manifest that drifted, not just that something did", async () => {
    const root = await fixture({
      constant: "1.0.0",
      manifests: { "apps/web/package.json": "0.9.0" },
    })

    const ran = await verify(root, "v1.0.0")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("apps/web/package.json")
    expect(ran.output).toContain("0.9.0")
  })

  test("covers a workspace member nobody remembered to add to the list", async () => {
    // Members come from the `workspaces` globs, so a package added tomorrow is gated today.
    const root = await fixture({
      constant: "1.0.0",
      extraMembers: ["packages/telemetry"],
      manifests: { "packages/telemetry/package.json": "0.1.0" },
    })

    const ran = await verify(root, "v1.0.0")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("packages/telemetry/package.json")
  })

  test("accepts a pre-release tag when the code calls itself that pre-release", async () => {
    // docs/RELEASING.md#pre-releases: an rc is a real tag with a real image. Its router has to say
    // it is an rc — `1.3.0` on an rc build is the impersonation this gate exists to stop.
    const root = await fixture({ constant: "1.3.0-rc.1" })

    expect((await verify(root, "v1.3.0-rc.1")).exitCode).toBe(0)
    expect((await verify(root, "v1.3.0")).exitCode).toBe(1)
  })

  test("refuses the unreleased placeholder even when everything agrees on it", async () => {
    const root = await fixture({ constant: "0.0.0" })

    const ran = await verify(root, "v0.0.0")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("0.0.0")
  })

  test("refuses to pass by finding nothing — an empty sweep is not agreement", async () => {
    // Every manifest agreed because none were discovered is the one failure a gate like this
    // reports as a pass. The globs come out of package.json, so a typo there is enough.
    const root = await fixture({ constant: "1.0.0" })
    await write(root, "package.json", JSON.stringify({ version: "1.0.0", workspaces: ["nope/*"] }))

    const ran = await verify(root, "v1.0.0")

    expect(ran.exitCode).toBe(1)
    expect(ran.output).toContain("no workspace manifests")
  })

  test("refuses a version no container tag could carry", async () => {
    // `+` is legal semver and illegal in an image tag: the release would build and then be
    // unnameable. Better to fail on the tag push than halfway through the pipeline.
    const root = await fixture({ constant: "1.0.0+deadbee" })

    expect((await verify(root, "v1.0.0+deadbee")).exitCode).toBe(1)
  })

  test("passes a tree that agrees with itself, with and without a tag", async () => {
    const root = await fixture({ constant: "2.1.0" })

    expect((await verify(root)).exitCode).toBe(0)
    expect((await verify(root, "v2.1.0")).exitCode).toBe(0)
  })
})
