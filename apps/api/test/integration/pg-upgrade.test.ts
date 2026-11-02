import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const script = fileURLToPath(new URL("../../../../bin/pg-upgrade-16-to-18", import.meta.url))

// Model Docker's process boundary: a populated target conflicts unless the dump
// replaces it, psql hides COPY errors unless ON_ERROR_STOP is enabled, and role
// state persists on the target across runs — $FIXTURE_DIR/roles seeds the
// initdb-created router role and records what a restore created, so a second
// run sees the first run's roles exactly like a rerun after a failed import.
const docker = `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$FIXTURE_DIR/commands"
case "$*" in
  *pg_isready*) exit 0 ;;
  *pg_dumpall*)
    if [[ -f "$FIXTURE_DIR/quoted-role.sql" ]]; then
      cat "$FIXTURE_DIR/quoted-role.sql"
      exit 0
    fi
    printf 'CREATE ROLE router;\\nALTER ROLE router WITH LOGIN;\\n'
    if [[ "$FIXTURE_EXTRA_ROLE" == 1 ]]; then
      printf 'CREATE ROLE legacy_app;\\nALTER ROLE legacy_app WITH LOGIN NOINHERIT;\\n'
    fi
    exit 0 ;;
  *pg_dump*) printf 'DROP DATABASE IF EXISTS router;\\nCREATE DATABASE router;\\nCOPY fixture FROM stdin;\\nlegacy\\n'; exit 0 ;;
  *psql*)
    if [[ "$*" == *-Atc* ]]; then echo 1; exit 0; fi
    body="$(cat)"
    if [[ "$body" == *'DROP DATABASE IF EXISTS router;'* ]]; then
      if [[ "$FIXTURE_FAIL_COPY" == 1 ]]; then
        echo 'ERROR: invalid input syntax in COPY' >&2
        [[ "$*" != *ON_ERROR_STOP=1* ]] || exit 3
      else
        printf legacy > "$FIXTURE_DIR/rows"
      fi
      exit 0
    fi
    printf '%s' "$body" > "$FIXTURE_DIR/restored-roles.sql"
    if [[ -f "$FIXTURE_DIR/quoted-role.sql" ]]; then exit 0; fi
    # Roles pass. A guarded CREATE runs only for roles the cluster lacks; a
    # bare CREATE for an existing role is the server's fatal duplicate error.
    if [[ "$body" == *'NOT EXISTS (SELECT FROM pg_roles'* ]]; then
      names="$(grep -oE "rolname = E'[^']+'" <<<"$body" | cut -d"'" -f2)"
      for role in $names; do
        grep -qxF "$role" "$FIXTURE_DIR/roles" || printf '%s\\n' "$role" >> "$FIXTURE_DIR/roles"
      done
      exit 0
    fi
    if [[ "$body" == *'CREATE ROLE'* ]]; then
      names="$(grep -oE '^CREATE ROLE [^ ;]+' <<<"$body" | awk '{print $3}')"
      for role in $names; do
        if grep -qxF "$role" "$FIXTURE_DIR/roles"; then
          echo "ERROR:  role \\"$role\\" already exists" >&2
          exit 3
        fi
        printf '%s\\n' "$role" >> "$FIXTURE_DIR/roles"
      done
    fi
    exit 0 ;;
esac
`

function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "router-pg-upgrade-"))
  writeFileSync(join(dir, "docker"), docker, { mode: 0o755 })
  writeFileSync(join(dir, "rows"), "legacy,stale-target-row")
  // The fresh postgres-data-18 cluster's initdb has already created router.
  writeFileSync(join(dir, "roles"), "router\n")
  return dir
}

function runScript(dir: string, failCopy: boolean, extraRole: boolean) {
  return spawnSync("bash", [script], {
    input: "migrate\n",
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH}`,
      LEGACY_VOLUME: "fixture-postgres-data",
      FIXTURE_DIR: dir,
      FIXTURE_FAIL_COPY: failCopy ? "1" : "0",
      FIXTURE_EXTRA_ROLE: extraRole ? "1" : "0",
    },
  })
}

function run(failCopy: boolean) {
  const dir = makeFixture()
  try {
    const result = runScript(dir, failCopy, false)
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      commands: readFileSync(join(dir, "commands"), "utf8"),
      rows: readFileSync(join(dir, "rows"), "utf8"),
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("PostgreSQL major upgrade", () => {
  test.each([
    ["o'reilly", "o''reilly", "$r$"],
    ['a"b', 'a"b', "$r$"],
    ["a\\b", "a\\\\b", "$r$"],
    ["a$r$b", "a$r$b", "$r1$"],
    ["a\nb", "a\nb", "$r$"],
  ])("quotes the legacy role %j in its existence guard", (name, literal, tag) => {
    const dir = makeFixture()
    try {
      const identifier = `"${name.replaceAll('"', '""')}"`
      const create = `CREATE ROLE ${identifier};`
      const alter = `ALTER ROLE ${identifier} WITH LOGIN;`
      writeFileSync(join(dir, "quoted-role.sql"), `${create}\n${alter}\n`)
      const result = runScript(dir, false, false)
      expect(result.status).toBe(0)
      expect(readFileSync(join(dir, "restored-roles.sql"), "utf8")).toBe(
        `DO ${tag} BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = E'${literal}') THEN ${create} END IF; END ${tag};\n${alter}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

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

  test("a rerun after a failed import reuses the roles the first attempt restored", () => {
    // The legacy cluster carries a role the fresh 18 cluster does not have. The
    // first attempt restores it, the database import fails, and the rerun must
    // skip the existing CREATEs and still finish: a bare CREATE ROLE aborts on
    // the duplicate — the fingerprint of the pre-fix script.
    const dir = makeFixture()
    try {
      const first = runScript(dir, true, true)
      expect(first.status).not.toBe(0)
      expect(first.stderr).toContain("ERROR: invalid input syntax in COPY")
      expect(readFileSync(join(dir, "roles"), "utf8")).toBe("router\nlegacy_app\n")

      const retry = runScript(dir, false, true)
      expect(retry.status).toBe(0)
      expect(readFileSync(join(dir, "roles"), "utf8")).toBe("router\nlegacy_app\n")
      expect(readFileSync(join(dir, "rows"), "utf8")).toBe("legacy")
      expect(retry.stdout).toContain("stack restarted on the migrated data")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
