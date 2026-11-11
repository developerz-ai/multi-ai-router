import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `bin/ci-apt-mirror` pins the CI runner's apt to archive.ubuntu.com when a listed mirror does not
 * resolve: a dead Azure mirror is retried with a DNS timeout per file and outlasts the job timeout.
 * Runs the real script against a fixture mirror file with `getent` stubbed on PATH.
 */

const SCRIPT = fileURLToPath(new URL("../../../../bin/ci-apt-mirror", import.meta.url))
const MIRRORS =
  "http://azure.archive.ubuntu.com/ubuntu/\tpriority:1\nhttp://archive.ubuntu.com/ubuntu/\tpriority:2\n"
const FALLBACK = "http://archive.ubuntu.com/ubuntu/\n"

/** A `getent` that fails for the Azure host only, or for none. */
const getent = (failHost: string) => `#!/bin/sh
[ "$2" = "${failHost}" ] && exit 2
echo "10.0.0.1 $2"
`

function run(options: { mirrors: string | null; failHost: string }) {
  const dir = mkdtempSync(join(tmpdir(), "router-apt-mirror-"))
  try {
    const file = join(dir, "apt-mirrors.txt")
    if (options.mirrors !== null) writeFileSync(file, options.mirrors)
    writeFileSync(join(dir, "getent"), getent(options.failHost), { mode: 0o755 })
    const result = spawnSync("bash", [SCRIPT], {
      encoding: "utf8",
      env: { PATH: `${dir}:${process.env.PATH ?? ""}`, APT_MIRRORS_FILE: file },
    })
    let after: string | null = null
    try {
      after = readFileSync(file, "utf8")
    } catch {}
    return { status: result.status, stdout: result.stdout, after }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("bin/ci-apt-mirror", () => {
  test("a mirror that does not resolve pins the file to archive.ubuntu.com alone", () => {
    const result = run({ mirrors: MIRRORS, failHost: "azure.archive.ubuntu.com" })

    expect(result.status).toBe(0)
    expect(result.after).toBe(FALLBACK)
    expect(result.stdout).toContain("azure.archive.ubuntu.com did not resolve")
  })

  test("mirrors that all resolve leave the file untouched", () => {
    const result = run({ mirrors: MIRRORS, failHost: "none.invalid" })

    expect(result.status).toBe(0)
    expect(result.after).toBe(MIRRORS)
    expect(result.stdout).toContain("left untouched")
  })

  test("an absent mirror file is left absent", () => {
    const result = run({ mirrors: null, failHost: "azure.archive.ubuntu.com" })

    expect(result.status).toBe(0)
    expect(result.after).toBeNull()
    expect(result.stdout).toContain("does not exist")
  })
})
