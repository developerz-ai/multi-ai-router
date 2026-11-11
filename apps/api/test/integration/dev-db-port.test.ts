import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `DEV_DB_PORT=5434 bin/setup` wrote `:5434` into `.env` but recorded the port nowhere, and
 * `bin/db` re-derived `${DEV_DB_PORT:-5433}` — so `bin/db migrate` hit whatever owned 5433 and
 * `bin/db reset` destroyed the volume, then failed to re-bind. Runs the real scripts in a scratch
 * root with `docker` stubbed on PATH; `$PUBLISHED` is what `docker compose port` answers.
 */

const ROOT = fileURLToPath(new URL("../../../../", import.meta.url))

const DOCKER = `#!/bin/sh
case "$*" in
  *" port postgres 5432") [ -n "$PUBLISHED" ] && echo "127.0.0.1:$PUBLISHED" && exit 0; exit 1 ;;
  *) exit 1 ;;
esac
`

function dbUrl(options: { env?: string; published?: string; variable?: string }): string {
  const root = mkdtempSync(join(tmpdir(), "router-dev-db-port-"))
  try {
    mkdirSync(join(root, "bin/lib"), { recursive: true })
    copyFileSync(join(ROOT, "bin/db"), join(root, "bin/db"))
    copyFileSync(join(ROOT, "bin/lib/dev-db-env"), join(root, "bin/lib/dev-db-env"))
    writeFileSync(join(root, "docker"), DOCKER, { mode: 0o755 })
    if (options.env !== undefined) writeFileSync(join(root, ".env"), options.env)
    const env: Record<string, string> = {
      PATH: `${root}:${process.env.PATH ?? ""}`,
      PUBLISHED: options.published ?? "",
    }
    if (options.variable !== undefined) env.DEV_DB_PORT = options.variable
    const result = spawnSync("bash", [join(root, "bin/db"), "url"], { encoding: "utf8", env })
    expect(result.status).toBe(0)
    return result.stdout.trim()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

describe("bin/db url", () => {
  test("uses the port bin/setup recorded in .env when nothing else names one", () => {
    expect(
      dbUrl({
        env: "DATABASE_URL=postgres://router:router@localhost:5434/router\nDEV_DB_PORT=5434\n",
      }),
    ).toBe("postgres://router:router@localhost:5434/router")
  })

  test("prefers the port the running container publishes over the recorded one", () => {
    expect(dbUrl({ env: "DEV_DB_PORT=5434\n", published: "5440" })).toContain("localhost:5440/")
  })

  test("lets an explicit DEV_DB_PORT win over everything", () => {
    expect(dbUrl({ env: "DEV_DB_PORT=5434\n", published: "5440", variable: "5441" })).toContain(
      "localhost:5441/",
    )
  })

  test("falls back to 5433 with nothing recorded and nothing running", () => {
    expect(dbUrl({})).toContain("localhost:5433/")
  })
})
