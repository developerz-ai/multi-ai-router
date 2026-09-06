import { describe, expect, test } from "bun:test"

/**
 * **The bundle is what runs, and it is not the source.**
 *
 * `bin/build` bundles the API to one file, and a bundler that hoists two modules into one scope
 * renames whatever collides — a local `row` becomes `row2`. When a module-scope function is
 * *already* named that, the minted local shadows it and every call site invokes a plain object
 * instead of the function.
 *
 * That failure is invisible to every other test in this repo. On 2026-09-06 the operator console's
 * usage dashboard answered `500` in production —
 * `TypeError: row2 is not a function. (In 'row2(row2, axis, points)', 'row2' is an instance of
 * Object)` — while the endpoint's own integration tests were green, because they exercise the
 * source, where the function and the parameter are different bindings. Only the shipped artifact
 * has the collision, so only a test that reads the shipped artifact can see it.
 *
 * The check is deliberately narrow: a **call** of the form `name(name, …)` where `name` is also a
 * module-scope `function` in the bundle. A function cannot meaningfully be its own first argument
 * here, so a hit is a shadowed binding rather than a style preference. Method definitions
 * (`where(where) { … }`, of which drizzle has several) are excluded by shape rather than by name,
 * so vendored code cannot make this test lie in either direction.
 *
 * The fix for a hit is always the same and always in *our* source: name the module-scope symbol
 * something a bundler will never mint — never `<word><digit>`.
 */

/** Module-scope `function` declarations in the bundle: `^function name(`. */
const DECLARATION = /^function ([A-Za-z_$][A-Za-z0-9_$]*)\(/gm

/** A bare call passing its own name as the first argument. `(?<![.\w$])` refuses `obj.name(name)`. */
const SELF_SHADOWED = /(?<![.\w$])([A-Za-z_$][A-Za-z0-9_$]*)\(\1[,)]/g

/** `where(where) { … }` is a method definition. A call is never followed by a block. */
const DEFINITION_TAIL = /^\s*\{/

function shadowedCallSites(bundle: string): string[] {
  const declared = new Set(Array.from(bundle.matchAll(DECLARATION), (match) => match[1]))
  const found = new Set<string>()

  for (const match of bundle.matchAll(SELF_SHADOWED)) {
    const name = match[1]
    if (name === undefined || !declared.has(name)) continue
    if (match[0].endsWith(")") && DEFINITION_TAIL.test(bundle.slice(match.index + match[0].length)))
      continue
    found.add(name)
  }
  return [...found].sort()
}

async function tmpdir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir: base } = await import("node:os")
  const { join } = await import("node:path")
  return await mkdtemp(join(base(), "mar-bundle-"))
}

describe("the shipped API bundle", () => {
  test("no module-scope function is shadowed by a bundler-renamed local at its own call site", async () => {
    // The same invocation `bin/build` ships, run through the CLI rather than `Bun.build()`: the
    // artifact under test has to be the artifact that is deployed, and a second build configured
    // differently would be a second thing to keep true.
    const outfile = `${await tmpdir()}/api.js`
    const build = Bun.spawn(
      ["bun", "build", "apps/api/src/main.ts", "--target=bun", "--outfile", outfile],
      { stdout: "pipe", stderr: "pipe" },
    )
    const failure = await new Response(build.stderr).text()
    expect({ code: await build.exited, failure }).toEqual({ code: 0, failure: "" })

    expect(shadowedCallSites(await Bun.file(outfile).text())).toEqual([])
  }, 180_000)
})

describe("the check itself", () => {
  test("it catches the exact shape that shipped the 500", () => {
    const bundle = [
      "function row2(row3, axis, points) {",
      "  return { ...row3, axis, points };",
      "}",
      "function label3(rows, axis, points) {",
      "  return rows.map((row2) => row2(row2, axis, points));",
      "}",
    ].join("\n")

    expect(shadowedCallSites(bundle)).toEqual(["row2"])
  })

  test("a method definition is not a call, however vendored code spells it", () => {
    const bundle = [
      "function where(clause) {",
      "  return clause;",
      "}",
      "class Q {",
      "  where(where) {",
      "    this.config.where = where;",
      "  }",
      "}",
    ].join("\n")

    expect(shadowedCallSites(bundle)).toEqual([])
  })

  test("a member call that happens to echo its own name is not a hit", () => {
    const bundle = [
      "function limit(n) {",
      "  return n;",
      "}",
      "const q = builder.limit(limit);",
    ].join("\n")

    expect(shadowedCallSites(bundle)).toEqual([])
  })
})
