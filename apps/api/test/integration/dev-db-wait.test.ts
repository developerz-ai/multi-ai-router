import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `bin/setup` failed on about half of fresh clones with "refusing to start on a half-migrated
 * schema" (#402). During initdb the Postgres image runs a temporary server that listens on the
 * container's Unix socket only; the readiness probe asked over that socket, so it reported ready
 * while the TCP port the host-side migration uses was still closed. Runs the real wait loop in a
 * scratch root with `docker` stubbed on PATH to model exactly that window: the socket answers at
 * once, TCP opens only after `$TCP_OPEN_AFTER` probes. `sleep` is stubbed so the loop runs at once.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const DOCKER = `#!/bin/sh
case "$*" in
  *" exec "*"-h 127.0.0.1"*)
    n=$(cat "$PROBES" 2>/dev/null || echo 0)
    n=$((n + 1))
    echo "$n" > "$PROBES"
    [ "$n" -gt "$TCP_OPEN_AFTER" ] && exit 0
    exit 1 ;;
  *" exec "*) exit 0 ;;
  *) exit 1 ;;
esac
`

function waitFor(tcpOpenAfter: number): { status: number | null; tcpProbes: number } {
  const root = mkdtempSync(join(tmpdir(), "router-dev-db-wait-"))
  try {
    mkdirSync(join(root, "bin/lib"), { recursive: true })
    copyFileSync(join(ROOT, "bin/lib/dev-db-env"), join(root, "bin/lib/dev-db-env"))
    writeFileSync(join(root, "docker"), DOCKER, { mode: 0o755 })
    writeFileSync(join(root, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const probes = join(root, "probes")
    const result = spawnSync("bash", ["-c", ". bin/lib/dev-db-env; dev_db_wait"], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${root}:${process.env.PATH ?? ""}`,
        PROBES: probes,
        TCP_OPEN_AFTER: String(tcpOpenAfter),
      },
    })
    let tcpProbes = 0
    try {
      tcpProbes = Number(readFileSync(probes, "utf8").trim())
    } catch {
      tcpProbes = 0
    }
    return { status: result.status, tcpProbes }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("bin/lib/dev-db-env dev_db_wait", () => {
  test("does not report ready while the TCP port is still closed", () => {
    // The socket answers from the first probe; ready must wait for the fourth TCP probe.
    const run = waitFor(3)
    expect(run.status).toBe(0)
    expect(run.tcpProbes).toBe(4)
  })

  test("a server that answers only on the socket is never ready", () => {
    const run = waitFor(1000)
    expect(run.status).toBe(1)
    expect(run.tcpProbes).toBe(60)
  })
})

describe("the compose healthchecks", () => {
  // The same probe gates `depends_on: service_healthy` in the bundled compose file and the dev
  // stack's health status, so both must ask over TCP and against the router database.
  for (const file of ["docker-compose.yml", "docker-compose.dev.yml"]) {
    test(`${file} probes the router database over TCP, not the socket`, () => {
      const text = readFileSync(join(ROOT, file), "utf8")
      expect(text).not.toContain("pg_isready -U router -d router")
      expect(text).toContain('psql -h 127.0.0.1 -U \\"$$POSTGRES_USER\\" -d \\"$$POSTGRES_DB\\"')
    })
  }
})
