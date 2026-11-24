import { afterEach, describe, expect, test } from "bun:test"
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `bin/test` and `bin/check`, run for real in a tree where everything they call is a stub.
 *
 * Two things here are properties of the shell the script happens to run under, which is why they
 * are executed rather than read:
 *
 * - **A shard with no database must fail.** `run_sharded` is called as `run_sharded || …`, where
 *   errexit is off; dash still aborts the shard's subshell on a failed assignment, bash (macOS's
 *   `/bin/sh`) carries on with an EMPTY `DATABASE_URL`. An empty exported value outranks `.env`,
 *   every live-Postgres suite skips, and the shard exits green: the run that proved less looking
 *   like the run that proved more.
 * - **A signal must stop the script's own children and nothing else.** `kill 0` signals the
 *   process group, and under CI, `timeout` or an agent's tool runner that group is the caller's.
 *   This test process shares its group with the script it starts, so a group-wide signal would
 *   kill the test run itself; surviving to make the assertions is half the proof.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url))
const BASE_URL = "postgres://router:router@127.0.0.1:1/router"

const trees: string[] = []
afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true })
})

function script(path: string, body: string): void {
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
}

/** A checkout with the real `name` script and stubs for everything it calls, plus a fake `bun`. */
function tree(
  name: "test" | "check",
  fakeBun: string,
): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "gate-scripts-"))
  trees.push(dir)
  mkdirSync(join(dir, "bin", "lib"), { recursive: true })
  mkdirSync(join(dir, "fake"))
  copyFileSync(join(ROOT, "bin", name), join(dir, "bin", name))
  chmodSync(join(dir, "bin", name), 0o755)
  script(join(dir, "bin", "lib", "require-bun"), "exit 0")
  script(join(dir, "bin", "lib", "database-url"), `printf '%s' '${BASE_URL}'`)
  script(join(dir, "bin", "build-cli-owner"), "exit 0")
  writeFileSync(join(dir, "bin", "lib", "test-timings.json"), '{"version":1,"files":{}}')
  script(join(dir, "fake", "bun"), fakeBun)
  const {
    CI: _ci,
    ROUTER_TEST_SHARDS: _shards,
    ROUTER_TEST_REQUIRE_DATABASE: _required,
    ...rest
  } = process.env as Record<string, string>
  return { dir, env: { ...rest, PATH: `${join(dir, "fake")}:${process.env.PATH ?? ""}`, OUT: dir } }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(20)
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const pidIn = (path: string): number => Number(readFileSync(path, "utf8").trim())

describe("bin/test shards", () => {
  /** Shard 2's database cannot be created; a shard that still runs records the URL it ran with. */
  const NO_SECOND_DATABASE = `
case "$1" in
  bin/lib/ensure-test-database.ts)
    [ "$3" = 1 ] || { echo "connection refused" >&2; exit 1; }
    printf '%s' "$2" ;;
  test)
    shard=$(printf '%s\\n' "$@" | sed -n 's/^--shard=\\([0-9]*\\).*/\\1/p')
    printf 'url=%s\\n' "\${DATABASE_URL-unset}" > "$OUT/ran.$shard" ;;
esac
exit 0`

  for (const shell of ["sh", "bash"]) {
    test(`under ${shell}, a shard whose database could not be prepared fails the run and never starts`, () => {
      const { dir, env } = tree("test", NO_SECOND_DATABASE)
      const run = Bun.spawnSync([shell, "bin/test"], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      const output = run.stdout.toString() + run.stderr.toString()

      expect(run.exitCode).not.toBe(0)
      expect(output).toContain("shard(s) 2 of 2 failed")
      // The healthy shard ran, on the database the caller named…
      expect(readFileSync(join(dir, "ran.1"), "utf8")).toBe(`url=${BASE_URL}\n`)
      // …and the other never reached \`bun test\` — least of all with an empty DATABASE_URL.
      expect(existsSync(join(dir, "ran.2"))).toBe(false)
    })
  }

  test("every shard passing is the only way the run passes", () => {
    const { dir, env } = tree(
      "test",
      `case "$1" in bin/lib/ensure-test-database.ts) printf '%s' "$2" ;; test) case "$*" in *--shard=2/2*) exit 3 ;; esac ;; esac
exit 0`,
    )
    const run = Bun.spawnSync(["sh", "bin/test"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })

    expect(run.exitCode).toBe(1)
    expect(run.stdout.toString()).toContain("shard 2/2 — exit 3")
    expect(run.stdout.toString()).toContain("shard 1/2 — exit 0")
  })

  test("a signal stops the shards by pid and leaves the caller's process group alone", async () => {
    const { dir, env } = tree(
      "test",
      `case "$1" in
  bin/lib/ensure-test-database.ts) printf '%s' "$2"; exit 0 ;;
  test)
    shard=$(printf '%s\\n' "$@" | sed -n 's/^--shard=\\([0-9]*\\).*/\\1/p')
    echo $$ > "$OUT/pid.$shard"
    exec sleep 60 ;;
esac
exit 0`,
    )
    // A sibling in this process's group: what \`kill 0\` would have taken down with the shards.
    const bystander = Bun.spawn(["sleep", "60"])
    const run = Bun.spawn(["sh", "bin/test"], { cwd: dir, env, stdout: "ignore", stderr: "ignore" })
    try {
      await until(
        () => existsSync(join(dir, "pid.1")) && existsSync(join(dir, "pid.2")),
        "both shards",
      )
      const shards = [pidIn(join(dir, "pid.1")), pidIn(join(dir, "pid.2"))]
      expect(shards.every(alive)).toBe(true)

      run.kill("SIGTERM")
      expect(await run.exited).toBe(130)
      await until(() => !shards.some(alive), "the shards to stop")
      expect(alive(bystander.pid)).toBe(true)
    } finally {
      bystander.kill()
      run.kill("SIGKILL")
    }
  })
})

describe("bin/check", () => {
  test("a signal stops typecheck and the suite by pid and leaves the caller's process group alone", async () => {
    const { dir, env } = tree(
      "check",
      `case "$1 $2" in
  "run typecheck") echo $$ > "$OUT/pid.typecheck"; exec sleep 60 ;;
esac
exit 0`,
    )
    // bin/check starts bin/test as a child of its own; this stands in for the whole suite.
    script(join(dir, "bin", "test"), 'echo $$ > "$OUT/pid.test"\nexec sleep 60')

    const bystander = Bun.spawn(["sleep", "60"])
    const run = Bun.spawn(["sh", "bin/check"], {
      cwd: dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await until(
        () => existsSync(join(dir, "pid.typecheck")) && existsSync(join(dir, "pid.test")),
        "typecheck and the suite",
      )
      const children = [pidIn(join(dir, "pid.typecheck")), pidIn(join(dir, "pid.test"))]
      expect(children.every(alive)).toBe(true)

      run.kill("SIGTERM")
      expect(await run.exited).toBe(130)
      await until(() => !children.some(alive), "typecheck and the suite to stop")
      expect(alive(bystander.pid)).toBe(true)
    } finally {
      bystander.kill()
      run.kill("SIGKILL")
    }
  })

  test("a failing stage prints its own output and names itself last", () => {
    const { dir, env } = tree(
      "check",
      `case "$1 $2" in "run lint") echo "lint: 3 problems in src/x.ts"; exit 1 ;; esac
exit 0`,
    )
    script(join(dir, "bin", "test"), "exit 0")
    const run = Bun.spawnSync(["sh", "bin/check"], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })
    const lines = (run.stdout.toString() + run.stderr.toString()).trim().split("\n")

    expect(run.exitCode).toBe(1)
    expect(lines.join("\n")).toContain("lint: 3 problems in src/x.ts")
    expect(lines.at(-1)).toContain("lint")
    expect(lines.at(-1)).toContain("bin/check stopped here")
  })
})
