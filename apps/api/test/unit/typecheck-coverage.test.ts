import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { API } from "typescript/unstable/async"

const root = resolve(import.meta.dir, "../../../..")
const api = join(root, "apps/api")
const testConfig = join(api, "tsconfig.tests.json")

function discover(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? discover(path) : path.endsWith(".ts") ? [path] : []
  })
}

function commands(path: string): string[] {
  return readFileSync(join(root, path), "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
}

describe("required API test and smoke typecheck", () => {
  test("includes every recursive test, helper, fixture and smoke source", async () => {
    const compiler = new API({ cwd: root })
    try {
      const parsed = await compiler.parseConfigFile(testConfig)
      const included = new Set(parsed.fileNames)
      for (const directory of ["test", "smoke"]) {
        const discovered = discover(join(api, directory))
        expect(discovered.length).toBeGreaterThan(0)
        expect(discovered.filter((path) => !included.has(path))).toEqual([])
      }
      for (const directory of ["test/unit", "test/integration", "test/support"]) {
        const prefix = `${join(api, directory)}/`
        expect(parsed.fileNames.some((path) => path.startsWith(prefix))).toBe(true)
      }
    } finally {
      await compiler.close()
    }
  })

  test("inherits checks without emission or rootDir restrictions", async () => {
    const compiler = new API({ cwd: root })
    try {
      const { options } = await compiler.parseConfigFile(testConfig)
      const base = await compiler.parseConfigFile(join(root, "tsconfig.base.json"))
      for (const [key, value] of Object.entries(base.options)) {
        if (["composite", "configFilePath"].includes(key)) continue
        expect(options[key]).toEqual(value)
      }
      expect(options.composite).toBe(false)
      expect(options.noEmit).toBe(true)
      expect(options.rootDir).toBeUndefined()
      expect(options.outDir).toBeUndefined()
      const production = await compiler.parseConfigFile(join(api, "tsconfig.json"))
      expect(production.options.rootDir).toBe(join(api, "src"))
      expect(production.options.outDir).toBe(join(api, "dist"))
    } finally {
      await compiler.close()
    }
  })

  test("reports assignment, null, index and unused errors in all four source areas", async () => {
    const files = new Map<string, string>()
    const compiler = new API({
      cwd: root,
      fs: {
        readFile: (path) => files.get(path),
        fileExists: (path) => (files.has(path) ? true : undefined),
      },
    })
    try {
      const parsed = await compiler.parseConfigFile(testConfig)
      const fixtures: string[] = []
      for (const directory of ["smoke", "test/unit", "test/integration", "test/support"]) {
        const path = parsed.fileNames.find((file) => file.startsWith(`${join(api, directory)}/`))
        if (!path) throw new Error(`No included source in ${directory}`)
        fixtures.push(path)
        // Replace only virtual roots; never load the real test or its imports, or write the checkout.
        files.set(
          path,
          `export const assignment: string = 123
export const nullable: string = undefined
export function indexed(values: string[]): string { return values[0] }
export function unused(parameter: string) { const local = 1; return 0 }
`,
        )
      }
      const virtualConfig = join(api, "tsconfig.coverage.virtual.json")
      files.set(
        virtualConfig,
        JSON.stringify({ extends: testConfig, files: fixtures, include: [] }),
      )
      const snapshot = await compiler.updateSnapshot({ openProjects: [virtualConfig] })
      try {
        const project = snapshot.getProject(virtualConfig)
        if (!project) throw new Error("Missing virtual coverage project")
        expect(await project.program.getConfigFileParsingDiagnostics()).toEqual([])
        expect(await project.program.getProgramDiagnostics()).toEqual([])
        for (const path of fixtures) {
          const diagnostics = await project.program.getSemanticDiagnostics(path)
          expect(diagnostics.filter((diagnostic) => diagnostic.code === 2322)).toHaveLength(3)
          expect(diagnostics.filter((diagnostic) => diagnostic.code === 6133)).toHaveLength(2)
        }
      } finally {
        await snapshot.dispose()
      }
    } finally {
      await compiler.close()
    }
  })

  test("bin/check requires bin/lint and the solution build followed by the no-emit project", () => {
    const manifest: { scripts: { typecheck: string } } = JSON.parse(
      readFileSync(join(root, "package.json"), "utf8"),
    )
    expect(manifest.scripts.typecheck.split(/\s*&&\s*/)).toEqual([
      "tsc --build --verbose",
      "tsc --project apps/api/tsconfig.tests.json",
    ])
    for (const path of ["bin/check", "bin/lint"]) {
      expect(commands(path)).toContain("set -eu")
    }
    expect(commands("bin/check")).toContain("bin/lint")
    expect(commands("bin/lint")).toContain("bun run typecheck")
  })
})
