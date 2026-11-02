import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../../../bin/pg-upgrade-16-to-18", import.meta.url))

// Model Docker's process boundary: a populated target conflicts unless the dump
// replaces it, and psql hides COPY errors unless ON_ERROR_STOP is enabled.
const docker = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_DIR/commands"
case "$*" in
  *pg_isready*) exit 0 ;;
  *pg_dumpall*) printf 'CREATE ROLE router;\\nALTER ROLE router WITH LOGIN;\\n'; exit 0 ;;
  *pg_dump*) printf 'DROP DATABASE IF EXISTS router;\\nCREATE DATABASE router;\\nCOPY fixture FROM stdin;\\nlegacy\\n'; exit 0 ;;
  *psql*)
    if [[ "$*" == *-Atc* ]]; then echo 1; exit 0; fi
    body="$(cat)"
    if [[ "$body" == *'CREATE ROLE router;'* ]]; then exit 3; fi
    if [[ "$body" == *COPY* ]]; then
      if [[ "$FIXTURE_FAIL_COPY" == 1 ]]; then
        echo 'ERROR: invalid input syntax in COPY' >&2
        [[ "$*" != *ON_ERROR_STOP=1* ]] || exit 3
      elif [[ "$*" == *pg_dumpall* || "$body" != *'DROP DATABASE IF EXISTS router;'* ]]; then
        echo 'ERROR: duplicate key value violates unique constraint' >&2
      else
        printf legacy > "$FIXTURE_DIR/rows"
      fi
    fi
    exit 0 ;;
esac
`

function run(failCopy: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "router-pg-upgrade-"))
  try {
    writeFileSync(join(dir, "docker"), docker, { mode: 0o755 })
    writeFileSync(join(dir, "rows"), "legacy,stale-target-row")
    const result = spawnSync("bash", [script], {
      input: "migrate\n",
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        LEGACY_VOLUME: "fixture-postgres-data",
        FIXTURE_DIR: dir,
        FIXTURE_FAIL_COPY: failCopy ? "1" : "0",
      },
    })
    return {
      ...result,
      commands: readFileSync(join(dir, "commands"), "utf8"),
      rows: readFileSync(join(dir, "rows"), "utf8"),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("PostgreSQL major upgrade", () => {
  test("replaces a populated target and restores roles without a bootstrap collision", () => {
    const result = run(false)
    expect(result.status).toBe(0)
    expect(result.rows).toBe("legacy")
    expect(result.commands).toContain("pg_dump -U router --clean --if-exists --create router")
    expect(result.commands.match(/psql .*ON_ERROR_STOP=1/g)).toHaveLength(2)
    expect(result.stdout).toContain("stack restarted on the migrated data")
  })

  test("COPY failure stops before restarting or recommending legacy-volume deletion", () => {
    const result = run(true)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain("ERROR: invalid input syntax in COPY")
    expect(result.commands).not.toMatch(/compose -f docker-compose.yml up -d\n/)
    expect(result.stdout).not.toContain("docker volume rm")
    expect(result.commands).toContain("rm -f pg-upgrade-16-legacy")
  })
})
