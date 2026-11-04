import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseSync } from "@babel/core"
import { compileSolidJsx } from "../support/solid-plugin"

// The repository has two Solid compilers, not one, and this suite pins the
// pair that actually exists:
//
//   * the test-side compile — `compileSolidJsx` in `test/support/solid-plugin.ts`,
//     which `bunfig.toml` preloads for every `.tsx` suite under
//     `apps/web/test/unit`. It runs `@babel/core` 8 with `babel-preset-solid`.
//   * the shipped build — `vite-plugin-solid` 2.x, which brings its own
//     `@babel/core` 7 and runs `babel-preset-solid` against it.
//
// The two cannot be merged from inside this repository: `babel-preset-solid`
// declares `@babel/core` `^7.0.0` as a peer and `vite-plugin-solid` declares
// `@babel/core` `^7.23.3` as a dependency, so the shipped build stays on
// Babel 7 while the test-side compile is already on Babel 8. The blocker guard
// below machine-checks that, so the day upstream opens those ranges the
// failure says so instead of the drift going unnoticed — it reads every major
// a declared range names, because upstream widens a range by adding a clause
// (`^7.0.0 || ^8.0.0`) rather than by replacing it.

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

const COMPONENT_SOURCE = `import { createSignal } from "solid-js"

function Badge(props: { label: string }) {
  return <span class="badge">{props.label}</span>
}

export function Counter() {
  const [count, setCount] = createSignal(0)
  return (
    <button class="counter" onClick={() => setCount(count() + 1)}>
      {count()}
      <Badge label="live" />
    </button>
  )
}
`

describe("Solid JSX compile", () => {
  test("a component compiles to Solid DOM output, not JSX", () => {
    const output = compileSolidJsx(
      COMPONENT_SOURCE,
      join(REPO_ROOT, "apps/web/test/unit/Counter.tsx"),
    )

    expect(output).toContain('from "solid-js/web"')
    expect(output).toContain("template(")
    expect(output).toContain("insert(")

    // React's automatic runtime would leave this behind; Solid compiles to
    // direct `createComponent`/`insert` calls.
    expect(output).not.toContain("react/jsx-runtime")
    expect(output).not.toContain("jsxDEV(")

    // No JSX is left: the component element is a call, and the whole output
    // parses as plain JavaScript (it would not parse at all with the JSX
    // syntax plugin switched off if any JSX had survived).
    expect(output).toContain("createComponent(Badge")
    expect(output).not.toContain("<Badge")
    expect(() => parseSync(output, { plugins: [] })).not.toThrow()
  })

  test("a call's type arguments are stripped (Babel 8 AST field)", () => {
    const output = compileSolidJsx(
      'const signal = createSignal<string>("x")',
      join(REPO_ROOT, "apps/web/test/unit/signal.tsx"),
    )

    expect(output).toContain('createSignal("x")')
    // Babel 8 renamed the AST field that carries a call's type arguments and
    // its TypeScript transform clears only the new name. On a Babel 7 core
    // the type argument survives into the output, which Bun then reads as a
    // comparison instead of a call.
    expect(output).not.toContain("createSignal<")
  })
})

interface PackageManifest {
  version?: string
  dependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function readInstalledManifest(pkg: string): PackageManifest {
  const candidates = [
    join(REPO_ROOT, "node_modules", pkg, "package.json"),
    join(REPO_ROOT, "apps", "web", "node_modules", pkg, "package.json"),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return JSON.parse(readFileSync(candidate, "utf8")) as PackageManifest
    }
  }
  throw new Error(`no installed manifest for ${pkg} (looked in ${candidates.join(", ")})`)
}

/**
 * Every major a declared range names — `^7.0.0` and `^7.23.3` are both `[7]`,
 * and a range widened to `^7.0.0 || ^8.0.0` is `[7, 8]`.
 *
 * All of them, not the first: upstream widens a range by adding a clause
 * rather than by replacing it, so the major that admits Babel 8 arrives
 * second and a read of the first major alone cannot see it. A prerelease
 * suffix (`^8.0.0-rc.1`) carries no second major.
 */
function declaredMajors(range: string): number[] {
  const matches = [...range.matchAll(/(?<![.\d-])(\d+)(?:\.\d+)*/g)]
  const majors = matches.map((match) => Number(match[1]))
  if (majors.length === 0) throw new Error(`no version in declared range "${range}"`)
  return [...new Set(majors)].sort((a, b) => a - b)
}

/**
 * The blocker guard: a declared range that names Babel 8 fails here, so the
 * day upstream opens the peer range or the dependency range the suite says so
 * instead of the drift going unnoticed.
 */
function expectBabel7Range(range: string): void {
  expect(declaredMajors(range)).toContain(7)
  expect(declaredMajors(range)).not.toContain(8)
}

describe("Solid compiler versions", () => {
  test("the test-side compile runs Babel 8", () => {
    const core = readInstalledManifest("@babel/core")
    expect(core.version).toBeDefined()
    expect(declaredMajors(core.version ?? "")).toEqual([8])
  })

  test("the shipped build is still pinned to Babel 7", () => {
    const preset = readInstalledManifest("babel-preset-solid")
    const vitePlugin = readInstalledManifest("vite-plugin-solid")

    const peerRange = preset.peerDependencies?.["@babel/core"]
    expect(peerRange).toBeDefined()
    expectBabel7Range(peerRange ?? "")

    const dependencyRange = vitePlugin.dependencies?.["@babel/core"]
    expect(dependencyRange).toBeDefined()
    expectBabel7Range(dependencyRange ?? "")
  })

  test("the blocker guard fails on a range widened to Babel 8", () => {
    // The shape upstream widens a peer range to: the major that admits
    // Babel 8 arrives second, so a read of the first major alone could not
    // see the range open.
    expect(declaredMajors("^7.0.0 || ^8.0.0")).toEqual([7, 8])
    expect(() => expectBabel7Range("^7.0.0 || ^8.0.0")).toThrow()

    // ... and the ranges as they stand today.
    expect(declaredMajors("^7.0.0")).toEqual([7])
    expect(declaredMajors("^7.23.3")).toEqual([7])
    expect(() => expectBabel7Range("^7.0.0")).not.toThrow()
  })

  test("the workspace declares the Babel 8 line for the test-side compile", () => {
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "apps", "web", "package.json"), "utf8"),
    ) as PackageManifest
    const devDependencies = manifest.devDependencies ?? {}

    expect(declaredMajors(devDependencies["@babel/core"] ?? "")).toEqual([8])
    expect(declaredMajors(devDependencies["@babel/plugin-syntax-jsx"] ?? "")).toEqual([8])
    expect(declaredMajors(devDependencies["@babel/preset-typescript"] ?? "")).toEqual([8])
  })
})
