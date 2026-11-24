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

/** A checkout with the real scripts named, stubs for everything they call, and a fake `bun`. */
function tree(
  real: readonly ("test" | "check")[],
  fakeBun: string,
): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "gate-scripts-"))
  trees.push(dir)
  mkdirSync(join(dir, "bin", "lib"), { recursive: true })
  mkdirSync(join(dir, "fake"))
  for (const name of real) {
    copyFileSync(join(ROOT, "bin", name), join(dir, "bin", name))
    chmodSync(join(dir, "bin", name), 0o755)
  }
  script(join(dir, "bin", "lib", "require-bun"), "exit 0")
  script(join(dir, "bin", "lib", "database-url"), `printf '%s' '${BASE_URL}'`)
  script(join(dir, "bin", "build-cli-owner"), "exit 0")
  writeFileSync(join(dir, "bin", "lib", "test-timings.json"), '{"version":1,"files":{}}')
  script(join(dir, "fake", "bun"), fakeBun)
  const {
    CI: _ci,
    ROUTER_TEST_SHARDS: _shards,
    ROUTER_TEST_REQUIRE_DATABASE: _required,
    ROUTER_TEST_VERBOSE: _verbose,
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

/** Fake-`bun` case arms, shared by the fixtures below. `$OUT` is the tree; `$1` the subcommand. */
const ARMS = {
  /** The shard-database helper: echoes the URL it was given ON STDIN, and records its argv. */
  ensureOk: `bin/lib/ensure-test-database.ts) printf '%s\\n' "$*" >> "$OUT/ensure.argv"; cat; exit 0 ;;`,
  /** `bun test` that records its pid under its shard number (0 when unsharded), then hangs. */
  hangingTest: `test)
    shard=$(printf '%s\\n' "$@" | sed -n 's/^--shard=\\([0-9]*\\).*/\\1/p')
    echo $$ > "$OUT/pid.\${shard:-0}"
    exec sleep 60 ;;`,
} as const

const fakeBun = (...arms: string[]): string => `case "$1" in\n${arms.join("\n")}\nesac\nexit 0`

describe("bin/test shards", () => {
  /** Shard 2's database cannot be created; a shard that still runs records the URL it ran with. */
  const NO_SECOND_DATABASE = fakeBun(
    `bin/lib/ensure-test-database.ts)
    [ "$2" = 1 ] || { echo "connection refused" >&2; exit 1; }
    cat; exit 0 ;;`,
    `test)
    shard=$(printf '%s\\n' "$@" | sed -n 's/^--shard=\\([0-9]*\\).*/\\1/p')
    printf 'url=%s\\n' "\${DATABASE_URL-unset}" > "$OUT/ran.$shard" ;;`,
  )

  for (const shell of ["sh", "bash"]) {
    test(`under ${shell}, a shard whose database could not be prepared fails the run and never starts`, () => {
      const { dir, env } = tree(["test"], NO_SECOND_DATABASE)
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
      // …and the other never reached `bun test` — least of all with an empty DATABASE_URL.
      expect(existsSync(join(dir, "ran.2"))).toBe(false)
    })
  }

  test("the database URL reaches the shard helper on stdin, never in its arguments", () => {
    // It carries a password, and an argument is in the process list for anyone to read.
    const { dir, env } = tree(["test"], fakeBun(ARMS.ensureOk))
    const run = Bun.spawnSync(["sh", "bin/test"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })

    expect(run.exitCode).toBe(0)
    const argv = readFileSync(join(dir, "ensure.argv"), "utf8")
    expect(argv.trim().split("\n").sort()).toEqual([
      "bin/lib/ensure-test-database.ts 1",
      "bin/lib/ensure-test-database.ts 2",
    ])
    expect(argv).not.toContain("postgres://")
  })

  test("every shard passing is the only way the run passes", () => {
    const { dir, env } = tree(
      ["test"],
      fakeBun(ARMS.ensureOk, `test) case "$*" in *--shard=2/2*) exit 3 ;; esac ;;`),
    )
    const run = Bun.spawnSync(["sh", "bin/test"], { cwd: dir, env, stdout: "pipe", stderr: "pipe" })

    expect(run.exitCode).toBe(1)
    expect(run.stdout.toString()).toContain("shard 2/2 — exit 3")
    expect(run.stdout.toString()).toContain("shard 1/2 — exit 0")
  })

  test("a signal stops the shards by pid and leaves the caller's process group alone", async () => {
    const { dir, env } = tree(["test"], fakeBun(ARMS.ensureOk, ARMS.hangingTest))
    // A sibling in this process's group: what `kill 0` would have taken down with the shards.
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
      // Reaped before the script exits, not merely signalled: nothing of the run outlives it.
      expect(shards.some(alive)).toBe(false)
      expect(alive(bystander.pid)).toBe(true)
    } finally {
      bystander.kill()
      run.kill("SIGKILL")
    }
  })

  test("a signal stops a single-process run too, where bun is the wrapper's only child", async () => {
    // `bin/test <pattern>` and `bin/test --changed`: with bun in the foreground the wrapper had no
    // trap to run, died on TERM, and left `bun test` on the database with nobody waiting for it.
    const { dir, env } = tree(["test"], fakeBun(ARMS.hangingTest))
    const run = Bun.spawn(["sh", "bin/test", "--changed=origin/main"], {
      cwd: dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    })
    try {
      await until(() => existsSync(join(dir, "pid.0")), "bun test")
      const suite = pidIn(join(dir, "pid.0"))

      run.kill("SIGTERM")
      expect(await run.exited).toBe(130)
      expect(alive(suite)).toBe(false)
    } finally {
      run.kill("SIGKILL")
    }
  })

  test("a signal during shard setup stops the database helper too, before the script exits", async () => {
    // The helper runs SQL (CREATE DATABASE). Left in a command substitution it outlived a TERM to
    // its shard: the script reported and exited while it was still talking to the server.
    const { dir, env } = tree(
      ["test"],
      fakeBun(`bin/lib/ensure-test-database.ts) echo $$ > "$OUT/pid.helper.$2"; exec sleep 60 ;;`),
    )
    const run = Bun.spawn(["sh", "bin/test"], { cwd: dir, env, stdout: "ignore", stderr: "ignore" })
    const files = [join(dir, "pid.helper.1"), join(dir, "pid.helper.2")]
    try {
      await until(() => files.every((file) => existsSync(file)), "both shards' helpers")
      const helpers = files.map(pidIn)
      expect(helpers.every(alive)).toBe(true)

      run.kill("SIGTERM")
      expect(await run.exited).toBe(130)
      expect(helpers.some(alive)).toBe(false)
    } finally {
      run.kill("SIGKILL")
    }
  })

  test("a failed shard is replayed whole even when it was streamed; a passing one is not", () => {
    // The live follower is killed, not drained: a failure written just before the shard exited may
    // never have been shown, and the last fifteen lines of a long log are not where it is.
    const { dir, env } = tree(
      ["test"],
      fakeBun(
        ARMS.ensureOk,
        `test)
    case "$*" in *--shard=2/2*) echo "(fail) the first failure, far above the summary" ;; *) echo "shard one, line one" ;; esac
    i=0; while [ $i -lt 40 ]; do echo "line $i"; i=$((i + 1)); done
    case "$*" in *--shard=2/2*) exit 1 ;; esac ;;`,
      ),
    )
    const run = Bun.spawnSync(["sh", "bin/test"], {
      cwd: dir,
      env: { ...env, ROUTER_TEST_VERBOSE: "1" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const out = run.stdout.toString()
    const passed = out.slice(out.indexOf("── shard 1/2 — exit 0 ──"), out.indexOf("── shard 2/2"))
    const failed = out.slice(out.indexOf("── shard 2/2 — exit 1 ──"))

    expect(run.exitCode).toBe(1)
    expect(failed).toContain("(fail) the first failure, far above the summary")
    expect(passed).not.toContain("shard one, line one")
    expect(passed).toContain("line 39")
  })

  test("streams the shards while they run when asked to, and still reports each at the end", async () => {
    const { dir, env } = tree(
      ["test"],
      fakeBun(
        ARMS.ensureOk,
        `test) echo "progress from $2"; while [ ! -e "$OUT/release" ]; do sleep 0.05; done; echo "summary of $2" ;;`,
      ),
    )
    const run = Bun.spawn(["sh", "bin/test"], {
      cwd: dir,
      env: { ...env, ROUTER_TEST_VERBOSE: "1" },
      stdout: "pipe",
      stderr: "ignore",
    })
    const reader = run.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    try {
      // Both shards are still blocked on the release file: this output can only be live.
      while (
        !(seen.includes("progress from --shard=1/2") && seen.includes("progress from --shard=2/2"))
      ) {
        const { done, value } = await reader.read()
        if (done) throw new Error(`the run ended before it streamed anything: ${seen}`)
        seen += decoder.decode(value, { stream: true })
      }
      expect(existsSync(join(dir, "release"))).toBe(false)

      writeFileSync(join(dir, "release"), "")
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        seen += decoder.decode(value, { stream: true })
      }
      expect(await run.exited).toBe(0)
      // The closing report is not left to the follower's timing.
      const report = seen.slice(seen.indexOf("── shard 1/2 — exit 0 ──"))
      expect(report).toContain("summary of --shard=1/2")
      expect(report).toContain("summary of --shard=2/2")
    } finally {
      writeFileSync(join(dir, "release"), "")
      run.kill("SIGKILL")
    }
  })
})

describe("bin/check", () => {
  /** `bun run typecheck` that records its pid and hangs; every other `bun run`/`install` passes. */
  const HANGING_TYPECHECK = `run) [ "$2" = typecheck ] || exit 0; echo $$ > "$OUT/pid.typecheck"; exec sleep 60 ;;`

  for (const mode of [[], ["--fast"]] as const) {
    const label = mode.length === 0 ? "the gate" : "--fast"
    const suitePids = mode.length === 0 ? ["pid.1", "pid.2"] : ["pid.0"]

    test(`${label}: a signal stops typecheck and the real bin/test's bun processes, and nothing else`, async () => {
      // The real wrapper under the real gate: a stub `bin/test` that is itself the sleeper cannot
      // show a wrapper dying while the bun it started keeps using the database.
      const { dir, env } = tree(
        ["check", "test"],
        fakeBun(ARMS.ensureOk, ARMS.hangingTest, HANGING_TYPECHECK),
      )
      const bystander = Bun.spawn(["sleep", "60"])
      const run = Bun.spawn(["sh", "bin/check", ...mode], {
        cwd: dir,
        env,
        stdout: "ignore",
        stderr: "ignore",
      })
      const files = ["pid.typecheck", ...suitePids].map((name) => join(dir, name))
      try {
        await until(() => files.every((file) => existsSync(file)), "typecheck and every bun test")
        const children = files.map(pidIn)
        expect(children.every(alive)).toBe(true)

        run.kill("SIGTERM")
        expect(await run.exited).toBe(130)
        expect(children.some(alive)).toBe(false)
        expect(alive(bystander.pid)).toBe(true)
      } finally {
        bystander.kill()
        run.kill("SIGKILL")
      }
    })

    test(`${label}: a type error is reported at once, and the suite it stopped is reaped`, async () => {
      const { dir, env } = tree(
        ["check", "test"],
        fakeBun(
          ARMS.ensureOk,
          ARMS.hangingTest,
          // Fails only once the suite is demonstrably running, so "at once" means "without it".
          `run) [ "$2" = typecheck ] || exit 0
    while ${suitePids.map((name) => `[ ! -e "$OUT/${name}" ]`).join(" || ")}; do sleep 0.02; done
    echo "src/x.ts(3,1): error TS2322: nope"; exit 2 ;;`,
        ),
      )
      const started = Date.now()
      const run = Bun.spawn(["sh", "bin/check", ...mode], {
        cwd: dir,
        env,
        stdout: "pipe",
        stderr: "pipe",
      })
      try {
        const [code, out, err] = await Promise.all([
          run.exited,
          new Response(run.stdout).text(),
          new Response(run.stderr).text(),
        ])
        const lines = (out + err).trim().split("\n")

        expect(code).toBe(1)
        // The suite sleeps for a minute; the verdict did not wait for it.
        expect(Date.now() - started).toBeLessThan(20_000)
        expect(lines.join("\n")).toContain("error TS2322: nope")
        expect(lines.at(-1)).toContain("typecheck")
        expect(lines.at(-1)).toContain("bin/check stopped here")
        expect(suitePids.map((name) => pidIn(join(dir, name))).some(alive)).toBe(false)
      } finally {
        run.kill("SIGKILL")
      }
    })
  }

  test("--verbose streams the suite while it runs and prints typecheck when it finishes, not after", async () => {
    const { dir, env } = tree(
      ["check", "test"],
      fakeBun(
        ARMS.ensureOk,
        `test) echo "progress from $2"; while [ ! -e "$OUT/release" ]; do sleep 0.05; done ;;`,
        `run) [ "$2" = typecheck ] && echo "typecheck: 0 errors"; exit 0 ;;`,
      ),
    )
    const run = Bun.spawn(["sh", "bin/check", "--verbose"], {
      cwd: dir,
      env,
      stdout: "pipe",
      stderr: "ignore",
    })
    const reader = run.stdout.getReader()
    const decoder = new TextDecoder()
    let seen = ""
    try {
      while (
        !(seen.includes("progress from --shard=2/2") && seen.includes("typecheck: 0 errors"))
      ) {
        const { done, value } = await reader.read()
        if (done) throw new Error(`bin/check --verbose ended before it streamed: ${seen}`)
        seen += decoder.decode(value, { stream: true })
      }
      // The suite is still blocked: both the test output and typecheck's arrived live.
      expect(existsSync(join(dir, "release"))).toBe(false)
      writeFileSync(join(dir, "release"), "")
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(await run.exited).toBe(0)
    } finally {
      writeFileSync(join(dir, "release"), "")
      run.kill("SIGKILL")
    }
  })

  test("a failing stage prints its own output and names itself last", () => {
    const { dir, env } = tree(
      ["check"],
      fakeBun(`run) [ "$2" = lint ] || exit 0; echo "lint: 3 problems in src/x.ts"; exit 1 ;;`),
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
