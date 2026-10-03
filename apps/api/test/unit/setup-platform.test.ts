import { expect, test } from "bun:test"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

async function setupFixture(platform: string, compilerAvailable: boolean) {
  const root = await mkdtemp(join(tmpdir(), "router-setup-platform-"))
  try {
    await mkdir(join(root, "bin/lib"), { recursive: true })
    await mkdir(join(root, "commands"))
    await copyFile(resolve("bin/setup"), join(root, "bin/setup"))
    const log = join(root, "calls")
    async function script(path: string, body: string) {
      await writeFile(join(root, path), `#!/bin/sh\n${body}\n`)
      await chmod(join(root, path), 0o755)
    }
    await script("bin/lib/require-bun", "exit 0")
    await script("bin/build-cli-owner", 'echo guardian >> "$SETUP_TEST_LOG"')
    await script("commands/uname", `echo ${platform}`)
    await script(
      "commands/bun",
      'if [ "$1" = --version ]; then echo 1.4.2; else echo "bun $*" >> "$SETUP_TEST_LOG"; fi',
    )
    await script("commands/docker", 'case "$*" in *" ps "*) echo postgres;; esac; exit 0')
    if (compilerAvailable) await script("commands/compiler", "exit 0")
    await writeFile(
      join(root, ".env"),
      [
        "ADMIN_OIDC_ISSUER_URL=https://example.invalid",
        "ADMIN_OIDC_CLIENT_ID=fixture",
        "ADMIN_OIDC_REDIRECT_URI=http://localhost/callback",
        "ADMIN_OIDC_ADMIN_EMAIL=fixture@example.invalid",
        "DATABASE_URL=postgres://fixture.invalid/router",
      ].join("\n"),
    )
    const result = Bun.spawnSync(["bash", join(root, "bin/setup")], {
      env: {
        ...process.env,
        PATH: `${join(root, "commands")}:${process.env.PATH}`,
        CC: join(root, "commands/compiler"),
        SETUP_TEST_LOG: log,
      },
    })
    const calls = await readFile(log, "utf8").catch(() => "")
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
      calls,
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test("non-Linux setup without a compiler installs and migrates with an explicit CLI limitation", async () => {
  const result = await setupFixture("Darwin", false)
  expect(result.exitCode).toBe(0)
  expect(result.calls).toContain("bun install")
  expect(result.calls).toContain("migrate")
  expect(result.calls).not.toContain("guardian")
  expect(result.output).toContain("CLI shared-root ownership requires Linux")
})

test("Linux setup refuses a missing compiler before installation or migration", async () => {
  const result = await setupFixture("Linux", false)
  expect(result.exitCode).toBe(1)
  expect(result.calls).toBe("")
  expect(result.output).toContain("C compiler/static libc headers missing")
})

test("Linux setup builds the guardian and continues through migration", async () => {
  const result = await setupFixture("Linux", true)
  expect(result.exitCode).toBe(0)
  expect(result.calls).toContain("guardian")
  expect(result.calls).toContain("migrate")
})
