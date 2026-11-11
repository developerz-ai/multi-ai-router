import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * A `v*` tag publishes `X.Y.Z` (and maybe `latest`) for whatever commit it names. v2.55.0's image
 * was built while main's `test` job was still running, and nothing would have stopped a red main
 * or an unmerged branch commit from publishing identically; the Dockerfile's own build-time
 * assertions first ran on the tag. These hold the workflow shape that closes both, and drive
 * `bin/release-gate` against a stubbed `gh`/`git` — the checked-in files are the artifact under
 * test, and nothing here touches GitHub.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))
const GATE = join(ROOT, "bin/release-gate")

interface Step {
  readonly name?: string
  readonly uses?: string
  readonly run?: string
  readonly with?: Record<string, unknown>
}

interface Job {
  readonly needs?: string | readonly string[]
  readonly permissions?: Record<string, string>
  readonly outputs?: Record<string, string>
  readonly steps?: readonly Step[]
}

interface Workflow {
  readonly concurrency?: { readonly "cancel-in-progress"?: unknown }
  readonly jobs: Record<string, Job>
}

function workflow(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(join(ROOT, ".github/workflows", name), "utf8")) as Workflow
}

function needs(job: Job | undefined): readonly string[] {
  const value = job?.needs ?? []
  return typeof value === "string" ? [value] : value
}

function steps(job: Job | undefined): readonly Step[] {
  return job?.steps ?? []
}

/** A GitHub Actions `${{ … }}` expression, spelled without tripping the template-string lint. */
const expr = (body: string) => `\${{ ${body} }}`

const RELEASE = workflow("release.yml")
const CI = workflow("ci.yml")

describe("release.yml", () => {
  test("builds nothing before the gate, and the gate proves version, CI and novelty", () => {
    expect(needs(RELEASE.jobs.build)).toContain("gate")
    expect(needs(RELEASE.jobs.merge)).toContain("gate")
    const gate = steps(RELEASE.jobs.gate).map((step) => step.run ?? "")
    expect(gate.some((run) => run.includes(`bin/verify-version "\${GITHUB_REF_NAME}"`))).toBe(true)
    expect(gate.some((run) => run.includes(`bin/release-gate "\${GITHUB_SHA}"`))).toBe(true)
    expect(gate.some((run) => /imagetools inspect[\s\S]*already published/.test(run))).toBe(true)
    expect(RELEASE.jobs.gate?.permissions?.checks).toBe("read")
  })

  test("reads main's layer cache but never exports one from a tag ref", () => {
    const build = steps(RELEASE.jobs.build).find((step) =>
      step.uses?.startsWith("docker/build-push-action"),
    )
    expect(build?.with?.["cache-from"]).toBeDefined()
    expect(build?.with?.["cache-to"]).toBeUndefined()
  })

  test("signs build provenance for the published manifest list", () => {
    const merge = RELEASE.jobs.merge
    expect(merge?.permissions?.["id-token"]).toBe("write")
    expect(merge?.permissions?.attestations).toBe("write")
    const attest = steps(merge).find((step) =>
      step.uses?.startsWith("actions/attest-build-provenance"),
    )
    expect(attest?.with?.["push-to-registry"]).toBe(true)
    expect(String(attest?.with?.["subject-digest"])).toContain("steps.inspect.outputs.digest")
  })

  test("moves `latest` only to the highest stable version", () => {
    expect(RELEASE.jobs.gate?.outputs?.latest).toBeDefined()
    const meta = steps(RELEASE.jobs.merge).find((step) =>
      step.uses?.startsWith("docker/metadata-action"),
    )
    expect(String(meta?.with?.tags)).toContain(
      `enable=${expr("needs.gate.outputs.latest == 'true'")}`,
    )
    const release = steps(RELEASE.jobs.github_release).find((step) =>
      step.uses?.startsWith("softprops/action-gh-release"),
    )
    expect(release?.with?.make_latest).toBe(expr("needs.gate.outputs.latest"))
  })
})

describe("ci.yml", () => {
  test("builds the release image on every run without pushing it", () => {
    const image = steps(CI.jobs.image).find((step) =>
      step.uses?.startsWith("docker/build-push-action"),
    )
    expect(image?.with?.push).toBe(false)
    expect(
      steps(CI.jobs.image).some(
        (step) => step.run?.includes("claude") && step.run.includes("--version"),
      ),
    ).toBe(true)
  })

  test("never cancels a main run the release gate may be waiting on", () => {
    expect(CI.concurrency?.["cancel-in-progress"]).toBe(expr("github.event_name == 'pull_request'"))
  })

  test("defines every check the release gate requires", () => {
    const defaults = readFileSync(GATE, "utf8").match(/RELEASE_GATE_CHECKS:-([^}]+)\}/)?.[1]
    expect(defaults).toBeDefined()
    for (const check of (defaults ?? "").split(" ")) expect(Object.keys(CI.jobs)).toContain(check)
  })
})

/** `gh` answers from $FIXTURE_DIR/runs-<n>, advancing one file per call; `git` from $FIXTURE_ANCESTOR. */
const GH = `#!/bin/sh
count=$(cat "$FIXTURE_DIR/calls" 2>/dev/null || echo 0)
count=$((count + 1))
echo "$count" > "$FIXTURE_DIR/calls"
file="$FIXTURE_DIR/runs-$count"
[ -f "$file" ] || file="$(ls "$FIXTURE_DIR"/runs-* | sort -V | tail -n 1)"
cat "$file"
`

const GIT = `#!/bin/sh
case "$1" in
  fetch) exit 0 ;;
  merge-base) [ "$FIXTURE_ANCESTOR" = 1 ] ;;
  *) exit 2 ;;
esac
`

function runGate(polls: readonly string[], options: { timeout?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "router-release-gate-"))
  try {
    writeFileSync(join(dir, "gh"), GH, { mode: 0o755 })
    writeFileSync(join(dir, "git"), GIT, { mode: 0o755 })
    polls.forEach((runs, index) => {
      writeFileSync(join(dir, `runs-${index + 1}`), runs)
    })
    const result = spawnSync("sh", [GATE, "abc123"], {
      encoding: "utf8",
      env: {
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        FIXTURE_DIR: dir,
        FIXTURE_ANCESTOR: "1",
        GITHUB_REPOSITORY: "owner/repo",
        RELEASE_GATE_CHECKS: "lint test",
        RELEASE_GATE_TIMEOUT_SECONDS: String(options.timeout ?? 60),
        RELEASE_GATE_POLL_SECONDS: "0",
      },
    })
    return {
      status: result.status,
      stderr: result.stderr,
      calls: readFileSync(join(dir, "calls"), "utf8"),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const row = (name: string, status: string, conclusion = "") => `${name}\t${status}\t${conclusion}\n`

describe("bin/release-gate", () => {
  test("refuses a commit that is not on main, before asking GitHub anything", () => {
    const dir = mkdtempSync(join(tmpdir(), "router-release-gate-"))
    try {
      writeFileSync(join(dir, "git"), GIT, { mode: 0o755 })
      const result = spawnSync("sh", [GATE, "abc123"], {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH ?? ""}`,
          FIXTURE_ANCESTOR: "0",
          GITHUB_REPOSITORY: "owner/repo",
        },
      })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain("is not on main")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("fails on any required check that did not succeed", () => {
    const result = runGate([
      row("lint", "completed", "success") + row("test", "completed", "failure"),
    ])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("'test' on abc123 concluded 'failure'")
  })

  test("treats a skipped or cancelled required check as a failure, not a pass", () => {
    const result = runGate([
      row("lint", "completed", "success") + row("test", "completed", "cancelled"),
    ])
    expect(result.status).toBe(1)
  })

  test("waits for checks still running and passes once all succeed", () => {
    const result = runGate([
      row("lint", "completed", "success") + row("test", "in_progress"),
      row("lint", "completed", "success"),
      row("lint", "completed", "success") +
        row("test", "completed", "success") +
        row("bench", "completed", "failure"),
    ])
    expect(result.status).toBe(0)
    expect(result.calls.trim()).toBe("3")
  })

  test("gives up after its timeout while a check is still missing", () => {
    const result = runGate([row("lint", "completed", "success")], { timeout: 0 })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("still waiting after 0s for: test")
  })
})
