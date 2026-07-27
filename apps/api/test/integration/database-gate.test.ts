import { afterAll, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

/**
 * Proves the two halves of the database gate agree with the run they guard.
 *
 * `bin/check` promises "if it passes here it passes on the PR", and seven suites
 * gate themselves on `DATABASE_URL` — so the gate is only worth anything if it
 * reads the value `bun test` reads. It did not: `bun test` always loads
 * `.env.test` and never loads `.env.local`, while the bare `bun -e` the gate
 * used does the opposite. A `.env.test` blanking `DATABASE_URL` passed the check
 * and then skipped every live-Postgres suite into a green summary.
 *
 * Real subprocesses against real dotenv files on disk, because that is the whole
 * question: no in-process stand-in can tell you what Bun's own loader does. No
 * provider and no database are touched — the fixtures only ever carry a string.
 */

const REPO_ROOT = resolve(import.meta.dir, "../../../..")
const RESOLVER = join(REPO_ROOT, "bin/lib/database-url")
const PRELOAD = join(REPO_ROOT, "apps/api/test/support/database-gate-preload.ts")

/** Reports back what the *test runner* resolved, which is the only opinion that counts. */
const PROBE = `import { test } from "bun:test"
test("probe", () => {
  process.stdout.write("URL[" + (process.env.DATABASE_URL ?? "") + "]")
})
`

const dirs: string[] = []

afterAll(async () => {
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })))
})

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "router-database-gate-"))
  dirs.push(dir)
  await Promise.all(
    Object.entries(files).map(([name, contents]) => writeFile(join(dir, name), contents)),
  )
  return dir
}

/**
 * The parent run has a real `DATABASE_URL` (and `NODE_ENV=test`, and possibly
 * `CI`) in its environment, and process env outranks every dotenv file — so a
 * child that inherited it would answer about the parent's database, not the
 * fixture's, and every assertion below would be vacuous.
 */
function cleanEnv(over: Record<string, string> = {}): Record<string, string> {
  const inherited: Record<string, string> = {}
  const dropped = new Set(["DATABASE_URL", "NODE_ENV", "CI", "ROUTER_TEST_REQUIRE_DATABASE"])

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !dropped.has(key)) inherited[key] = value
  }
  return { ...inherited, ...over }
}

interface Ran {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

async function run(cmd: string[], cwd: string, env: Record<string, string>): Promise<Ran> {
  const child = Bun.spawn(cmd, { cwd, env, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { stdout, stderr, exitCode: await child.exited }
}

/** What `bun test` itself resolves in `cwd` — ground truth, not an emulation of one. */
async function runnerSees(cwd: string): Promise<string> {
  const { stdout } = await run(["bun", "test", "probe.test.ts"], cwd, cleanEnv())
  return /URL\[(.*)\]/.exec(stdout)?.[1] ?? "<probe did not report>"
}

/** What `bin/check` and `bin/test` believe before the run starts. */
async function gateSees(cwd: string): Promise<string> {
  const { stdout } = await run([RESOLVER], cwd, cleanEnv())
  return stdout
}

/** The resolver the gate used to use, kept only to show what it got wrong. */
async function bareBunSees(cwd: string): Promise<string> {
  const read = 'process.stdout.write(process.env.DATABASE_URL ?? "")'
  const { stdout } = await run(["bun", "-e", read], cwd, cleanEnv())
  return stdout
}

const URL_IN_ENV = "postgres://router:router@localhost:5432/from-dot-env"

describe("the gate's DATABASE_URL and the test runner's", () => {
  test("agree when .env.test blanks it — the case that used to skip into a green run", async () => {
    const dir = await fixture({
      ".env": `DATABASE_URL=${URL_IN_ENV}\n`,
      ".env.test": "DATABASE_URL=\n",
      "probe.test.ts": PROBE,
    })

    expect(await runnerSees(dir)).toBe("")
    expect(await gateSees(dir)).toBe("")
    // The regression itself: this is what the gate answered, and why seven suites
    // could skip while `bin/check` reported a pass.
    expect(await bareBunSees(dir)).toBe(URL_IN_ENV)
  })

  test("agree when .env.local blanks it — `bun test` never reads that file", async () => {
    const dir = await fixture({
      ".env": `DATABASE_URL=${URL_IN_ENV}\n`,
      ".env.local": "DATABASE_URL=\n",
      "probe.test.ts": PROBE,
    })

    expect(await runnerSees(dir)).toBe(URL_IN_ENV)
    expect(await gateSees(dir)).toBe(URL_IN_ENV)
    // The mirror-image failure: the gate refused a run that had a database.
    expect(await bareBunSees(dir)).toBe("")
  })

  test("agree when .env.test overrides it, rather than reading .env or .env.development", async () => {
    const dir = await fixture({
      ".env": `DATABASE_URL=${URL_IN_ENV}\n`,
      ".env.test": "DATABASE_URL=postgres://router:router@localhost:5432/from-dot-env-test\n",
      ".env.development": "DATABASE_URL=postgres://router:router@localhost:5432/from-dot-env-dev\n",
      "probe.test.ts": PROBE,
    })

    const runner = await runnerSees(dir)

    expect(runner).toContain("from-dot-env-test")
    expect(await gateSees(dir)).toBe(runner)
  })
})

describe("the preload that refuses a run which promised a database", () => {
  async function gated(env: Record<string, string>): Promise<Ran> {
    const dir = await fixture({
      "bunfig.toml": `[test]\npreload = ["${PRELOAD}"]\n`,
      "probe.test.ts": PROBE,
    })
    return run(["bun", "test", "probe.test.ts"], dir, cleanEnv(env))
  }

  /** `bun test` writes its summary to stderr and the probe writes to stdout. */
  const output = (ran: Ran): string => `${ran.stdout}\n${ran.stderr}`

  test("fails the run when bin/check promised one and .env.test took it away", async () => {
    const ran = await gated({ ROUTER_TEST_REQUIRE_DATABASE: "1" })

    expect(ran.exitCode).not.toBe(0)
    // Not "1 pass" with a warning somewhere above it: nothing may report green,
    // and the tests must not have run at all.
    expect(output(ran)).not.toContain("pass")
    expect(ran.stderr).toContain("DATABASE_URL is not set")
    expect(ran.stderr).toContain("bin/setup")
  })

  test("fails the run in CI, where a green summary is what a merge is decided on", async () => {
    const { exitCode, stderr } = await gated({ CI: "true" })

    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("CI is set")
  })

  test("says it once, not once per test file, so the remedy is not buried", async () => {
    const { stderr } = await gated({ CI: "true" })

    expect(stderr.split("DATABASE_URL is not set")).toHaveLength(2)
  })

  test("lets the run through once a database is there", async () => {
    const ran = await gated({
      CI: "true",
      DATABASE_URL: "postgres://router:router@localhost:5432/router",
    })

    expect(ran.exitCode).toBe(0)
    expect(output(ran)).toContain("1 pass")
  })

  test("stays out of the way of a bare database-less run — the no-Docker laptop loop", async () => {
    const ran = await gated({})

    expect(ran.exitCode).toBe(0)
    expect(output(ran)).toContain("1 pass")
  })
})
