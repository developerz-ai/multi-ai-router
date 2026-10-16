import { expect, test } from "bun:test"
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { createCliProbe } from "../../src/providers/claude-sdk/cli-probe"
import { resolveClaudeCli } from "../../src/providers/claude-sdk/resolve-cli"

test("bundled fast-profile check works without workspace package links, as in the image", async () => {
  const root = await mkdtemp(join(tmpdir(), "router-packaged-profile-"))
  try {
    await Promise.all([
      mkdir(join(root, "api")),
      mkdir(join(root, "libexec")),
      mkdir(join(root, "bin")),
      // Match the image and prevent Bun auto-installing a missing package from npm.
      mkdir(join(root, "node_modules")),
    ])
    const cli = resolveClaudeCli(createCliProbe({ override: null }))
    if (!cli.ok) throw new Error("installed SDK CLI missing from packaging fixture")
    await symlink(cli.path, join(root, "bin/claude"))
    const require = createRequire(import.meta.url)
    const sdk = require.resolve("@anthropic-ai/claude-agent-sdk")
    await copyFile(join(dirname(sdk), "manifest.json"), join(root, "libexec/claude-manifest.json"))
    const build = await Bun.build({
      entrypoints: [resolve("apps/api/src/providers/claude-fast/profile-check.ts")],
      target: "bun",
      outdir: join(root, "api"),
    })
    expect(build.success).toBe(true)
    const run = async () => {
      const child = Bun.spawn(
        [process.execPath, "--no-install", join(root, "api/profile-check.js")],
        {
          cwd: root,
          env: { PATH: join(root, "bin") },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [stdout, stderr, exit] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return { stdout, stderr, exit }
    }
    const result = await run()
    expect(result.exit, result.stderr).toBe(0)
    const expected = process.platform === "linux" && process.arch === "x64"
    expect(JSON.parse(result.stdout).available).toBe(expected)
    if (expected) {
      await writeFile(
        join(root, "libexec/claude-manifest.json"),
        JSON.stringify({ version: "2.1.999" }),
      )
      const wrong = await run()
      expect(wrong.exit).not.toBe(0)
      expect(wrong.stderr).toContain("manifest")
      await rm(join(root, "libexec/claude-manifest.json"))
      const missing = await run()
      expect(missing.exit).not.toBe(0)
      expect(missing.stderr).toContain("unavailable")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)
