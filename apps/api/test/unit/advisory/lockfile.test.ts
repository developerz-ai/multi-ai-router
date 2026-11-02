import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { LockfileParseError, parseLockfile } from "../../../advisory/lockfile"

/**
 * The parser behind the advisory gate.
 *
 * The fixtures are synthetic; the one real input is this repository's own `bun.lock`, because the
 * parser has to survive the file it is actually pointed at — JSONC with comments, trailing commas,
 * workspace entries and the same package resolved at two versions.
 */

const ROOT = resolve(import.meta.dir, "../../../../..")

const REPO_LOCKFILE = readFileSync(join(ROOT, "bun.lock"), "utf8")

describe("the repository's own lockfile", () => {
  test("resolves into more than a hundred third-party packages", () => {
    const packages = parseLockfile(REPO_LOCKFILE)

    expect(packages.length).toBeGreaterThan(100)
    // A known direct dependency, so a parser that returned the right *count* of the wrong things
    // would still fail here.
    expect(packages.some((entry) => entry.name === "zod")).toBe(true)
    expect(packages.some((entry) => entry.name === "hono")).toBe(true)
  })

  test("holds no workspace entry among them", () => {
    const packages = parseLockfile(REPO_LOCKFILE)

    // `…@workspace:packages/core` is this repository, not a published dependency.
    expect(packages.some((entry) => entry.version.startsWith("workspace:"))).toBe(false)
    expect(packages.some((entry) => entry.name.startsWith("@multi-ai-router/"))).toBe(false)
  })

  test("keeps one package resolved at two versions apart", () => {
    const packages = parseLockfile(REPO_LOCKFILE)
    const versions = new Map<string, Set<string>>()
    for (const entry of packages) {
      const seen = versions.get(entry.name) ?? new Set<string>()
      seen.add(entry.version)
      versions.set(entry.name, seen)
    }
    const split = [...versions.entries()].filter(([, seen]) => seen.size > 1)

    // A hoisted tree keeps both versions when the ranges disagree; collapsing them would let an
    // advisory against one version pass for the other.
    expect(split.length).toBeGreaterThan(0)
  })
})

describe("the JSONC scanner", () => {
  test("reads a lockfile with comments and trailing commas", () => {
    const text = `{
  // a line comment
  "packages": {
    /* a block
       comment */
    "fixture-pkg": ["fixture-pkg@1.2.3", "", {}],
    "@scope/pkg": ["@scope/pkg@0.1.0", "", {}],
  },
}`

    expect(parseLockfile(text)).toEqual([
      { name: "@scope/pkg", version: "0.1.0" },
      { name: "fixture-pkg", version: "1.2.3" },
    ])
  })

  test("leaves a string that contains a brace and a comma alone", () => {
    // The naive scanner drops the comma before the `}` inside the string and the note stops being
    // the note it was.
    const text = `{"packages": {"fixture-pkg": ["fixture-pkg@1.0.0", "", {"note": "a } and a , inside"}]}}`

    const packages = parseLockfile(text)

    expect(packages).toEqual([{ name: "fixture-pkg", version: "1.0.0" }])
  })

  test("excludes an entry whose version is a workspace resolution", () => {
    const text = `{
  "packages": {
    "@scope/app": ["@scope/app@workspace:packages/app"],
    "real-pkg": ["real-pkg@1.0.0", "", {}],
  },
}`

    expect(parseLockfile(text)).toEqual([{ name: "real-pkg", version: "1.0.0" }])
  })
})

describe("a lockfile that cannot be read", () => {
  test("throws rather than returning an empty list", () => {
    // An empty list assessed as "clean" is a green build that proved nothing about the tree.
    expect(() => parseLockfile("{ not json")).toThrow(LockfileParseError)
    expect(() => parseLockfile('{"packages": {"broken": []}}')).toThrow(LockfileParseError)
    expect(() => parseLockfile('{"packages": {"broken": ["no-version"]}}')).toThrow(
      LockfileParseError,
    )
  })

  test("throws when there is no packages section, and when it resolves nothing", () => {
    expect(() => parseLockfile("{}")).toThrow(LockfileParseError)
    expect(() => parseLockfile('{"packages": {}}')).toThrow(LockfileParseError)
    expect(() =>
      parseLockfile('{"packages": {"@scope/app": ["@scope/app@workspace:apps/web"]}}'),
    ).toThrow(LockfileParseError)
  })

  test("names the failure, so the report says why the assessment could not complete", () => {
    expect(() => parseLockfile("{}")).toThrow("packages")
    expect(() => parseLockfile('{"packages": {}}')).toThrow("nothing to assess")
  })
})
