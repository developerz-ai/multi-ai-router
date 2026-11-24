import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Proves the runtime image's `auto = "disable"` is what stops bun fetching a missing package.
 *
 *   bun auto-install-probe.ts <the shipped bunfig.toml>
 *
 * The image carries no node_modules, and bun's default with none is to AUTO-INSTALL an unresolved
 * bare import from the registry at run time. `/app/bunfig.toml` turns that off. The obvious check —
 * import a real package and require the import to fail — proves nothing when the network is what
 * failed it: a build with no route to the registry passes with auto-install fully on.
 *
 * So the registry is this process. It serves one package nobody else has, from 127.0.0.1, and the
 * same import is run twice against it:
 *
 *   1. POSITIVE CONTROL, auto-install on (bun's default): the import must SUCCEED and the registry
 *      must have been asked. That shows the mechanism works here and reaches this registry — the
 *      only thing that makes step 2 mean anything.
 *   2. THE SHIPPED CONFIG, pointed at the same registry: the import must FAIL and the registry must
 *      NOT have been asked.
 *
 * Each run gets its own empty working directory and its own empty install cache, so neither can be
 * satisfied by what the other fetched. No network beyond loopback is touched.
 */

const PACKAGE = "router-auto-install-probe"
const VERSION = "1.0.0"

function fail(message: string): never {
  process.stderr.write(`auto-install-probe: ${message}\n`)
  process.exit(1)
}

const shippedPath = process.argv[2]
if (shippedPath === undefined) {
  process.stderr.write("usage: auto-install-probe.ts <bunfig.toml>\n")
  process.exit(64)
}
const shipped = await Bun.file(shippedPath).text()
if (!/^\s*auto\s*=\s*"disable"\s*$/m.test(shipped)) {
  fail(`${shippedPath} does not set auto = "disable"`)
}

const root = mkdtempSync(join(tmpdir(), "auto-install-probe-"))
try {
  // The package, as a registry tarball: `package/package.json` + `package/index.js`.
  const source = join(root, "source", "package")
  mkdirSync(source, { recursive: true })
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: PACKAGE, version: VERSION, main: "index.js" }),
  )
  writeFileSync(join(source, "index.js"), 'module.exports = "fetched"\n')
  const tarball = join(root, "probe.tgz")
  const packed = Bun.spawnSync(["tar", "-czf", tarball, "-C", join(root, "source"), "package"])
  if (packed.exitCode !== 0) fail(`could not pack the probe package: ${packed.stderr.toString()}`)
  const bytes = new Uint8Array(await Bun.file(tarball).arrayBuffer())
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`
  const shasum = new Bun.CryptoHasher("sha1").update(bytes).digest("hex")

  let requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const { pathname, origin } = new URL(request.url)
      requests.push(pathname)
      if (pathname === `/${PACKAGE}`) {
        return Response.json({
          name: PACKAGE,
          "dist-tags": { latest: VERSION },
          versions: {
            [VERSION]: {
              name: PACKAGE,
              version: VERSION,
              main: "index.js",
              dist: {
                tarball: `${origin}/${PACKAGE}/-/${PACKAGE}-${VERSION}.tgz`,
                integrity,
                shasum,
              },
            },
          },
        })
      }
      if (pathname.endsWith(".tgz")) return new Response(bytes)
      return new Response("not found", { status: 404 })
    },
  })
  const registry = `http://127.0.0.1:${server.port}/`

  /** The import, in a directory holding only `bunfig`, with an install cache of its own. */
  const attempt = async (name: string, bunfig: string) => {
    const cwd = join(root, name)
    mkdirSync(join(cwd, "cache"), { recursive: true })
    writeFileSync(join(cwd, "bunfig.toml"), bunfig)
    requests = []
    const child = Bun.spawn(
      [process.execPath, "-e", `const m = await import("${PACKAGE}"); console.log(m.default)`],
      {
        cwd,
        env: { PATH: process.env.PATH ?? "", HOME: cwd, BUN_INSTALL_CACHE_DIR: join(cwd, "cache") },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout: stdout.trim(), stderr: stderr.trim(), asked: [...requests] }
  }

  try {
    const control = await attempt("control", `[install]\nregistry = "${registry}"\n`)
    if (control.code !== 0 || control.stdout !== "fetched" || control.asked.length === 0) {
      fail(
        "the positive control did not auto-install, so a failing import below would prove nothing.\n" +
          `  exit ${control.code}, stdout ${JSON.stringify(control.stdout)}, registry asked for ${JSON.stringify(control.asked)}\n` +
          `  ${control.stderr}`,
      )
    }

    // The shipped file, plus the registry line — so the only difference from the control is what
    // the image actually ships. An `[install]` table is merged, not duplicated.
    const underTest = shipped.includes("[install]")
      ? shipped.replace("[install]", `[install]\nregistry = "${registry}"`)
      : `${shipped}\n[install]\nregistry = "${registry}"\n`
    const disabled = await attempt("shipped", underTest)
    if (disabled.code === 0)
      fail("with the shipped bunfig the import SUCCEEDED: bun auto-installed")
    if (disabled.asked.length > 0) {
      fail(
        `with the shipped bunfig bun still asked the registry for ${JSON.stringify(disabled.asked)}`,
      )
    }

    process.stdout.write(
      `auto-install-probe: on by default (fetched ${control.asked.length} registry paths), off with ${shippedPath} (0 fetched, import failed)\n`,
    )
  } finally {
    await server.stop(true)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
