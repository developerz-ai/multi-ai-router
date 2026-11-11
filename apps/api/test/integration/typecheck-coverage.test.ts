import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Glob } from "bun"

/**
 * `bun test` strips types and checks nothing, so a TypeScript file outside every tsc project is
 * never type-checked: a test calling a function with a stale arity passes at runtime with the
 * missing argument `undefined`, exercising a shape production never sends. That is how ~130 type
 * errors hid behind a green gate. This holds the invariant structurally — every TypeScript file
 * in the workspace is included by a project the `typecheck` script actually runs — so a new test
 * or tooling directory cannot fall out of the gate again.
 *
 * Reading the checked-in configs is the assertion: they are the artifact under test.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

/** Workspace roots that hold TypeScript, and the build output / dependency trees under them. */
const SOURCE_GLOB = new Glob("{apps,packages,bin,native}/**/*.{ts,tsx}")
const IGNORED = /(^|\/)(node_modules|dist|dist-types[^/]*)\//

interface TsConfig {
  readonly include?: readonly string[]
  readonly exclude?: readonly string[]
  readonly references?: readonly { readonly path: string }[]
}

interface Project {
  readonly path: string
  readonly include: readonly Glob[]
  readonly exclude: readonly Glob[]
}

function readConfig(path: string): TsConfig {
  return Bun.JSONC.parse(readFileSync(join(ROOT, path), "utf8")) as TsConfig
}

/** tsc reads an include entry with no wildcard and no extension as a directory. */
function toGlob(base: string, pattern: string): Glob {
  const directory = !/[*?]/.test(pattern) && !/\.[cm]?tsx?$/.test(pattern)
  const relativePattern = join(base, directory ? `${pattern}/**/*` : pattern)
  return new Glob(relativePattern)
}

function project(configPath: string): Project {
  const config = readConfig(configPath)
  const base = dirname(configPath)
  return {
    path: configPath,
    include: (config.include ?? []).map((pattern) => toGlob(base, pattern)),
    exclude: (config.exclude ?? []).map((pattern) => toGlob(base, pattern)),
  }
}

/** A solution config contributes every project it references, transitively. */
function withReferences(configPath: string, seen: Set<string>): readonly string[] {
  if (seen.has(configPath)) return []
  seen.add(configPath)
  const base = dirname(configPath)
  const references = (readConfig(configPath).references ?? []).map((reference) => {
    const target = join(base, reference.path)
    return target.endsWith(".json") ? target : join(target, "tsconfig.json")
  })
  return [configPath, ...references.flatMap((reference) => withReferences(reference, seen))]
}

/** Every tsconfig the root `typecheck` script hands to tsc, `--build` references included. */
function typecheckedProjects(): readonly Project[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  const script = manifest.scripts?.typecheck ?? ""
  const seen = new Set<string>()
  const paths: string[] = []
  for (const [, flag, target] of script.matchAll(
    /tsc\s+(--build|-b|--project|-p)\b\s*([^\s&;|]*)/g,
  )) {
    const build = flag === "--build" || flag === "-b"
    const config = target && !target.startsWith("-") ? target : "tsconfig.json"
    paths.push(...(build ? withReferences(config, seen) : [config]))
  }
  return paths.map(project)
}

function covered(file: string, projects: readonly Project[]): boolean {
  return projects.some(
    (candidate) =>
      candidate.include.some((glob) => glob.match(file)) &&
      !candidate.exclude.some((glob) => glob.match(file)),
  )
}

describe("the typecheck gate", () => {
  const projects = typecheckedProjects()

  test("runs the solution build and the non-composite test and tooling projects", () => {
    const names = projects.map((candidate) => candidate.path)
    expect(names).toContain("tsconfig.json")
    expect(names).toContain(join("apps", "api", "tsconfig.tests.json"))
    expect(names).toContain(join("packages", "db", "tsconfig.tests.json"))
    expect(names).toContain(join("apps", "web", "tsconfig.tests.json"))
    expect(names).toContain("tsconfig.tools.json")
  })

  test("covers every TypeScript file in the workspace", () => {
    const files = [...SOURCE_GLOB.scanSync({ cwd: ROOT, dot: false })].filter(
      (file) => !IGNORED.test(file),
    )
    // A broken glob that finds nothing would pass the check below vacuously.
    expect(files.some((file) => file.endsWith(".test.ts"))).toBe(true)
    expect(files.filter((file) => !covered(file, projects))).toEqual([])
  })
})
