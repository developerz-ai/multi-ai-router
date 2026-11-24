import { isBuiltin } from "node:module"

/**
 * Fails when a shipped bundle still names a package it would have to find in node_modules.
 *
 * The runtime image carries `dist/` and no node_modules, with bun's auto-install off. A bare
 * specifier that survived bundling — an `--external`, a dependency the bundler could not follow, a
 * `require()` it left alone — would then fail at the moment that code path first runs, which for a
 * lazy import is some request in production rather than the build. This reads every import the
 * bundle really contains (parsed, so a specifier quoted inside a string or generated code is not
 * one) and refuses any that is neither a runtime builtin nor a path.
 *
 *   bun bin/lib/assert-bundles-self-contained.ts dist/api/index.js [more bundles…]
 *
 * Imports whose specifier is computed at run time cannot be listed by any parser. The runtime
 * image's `auto = "disable"` is the backstop for those: they fail closed instead of downloading.
 */

const transpiler = new Bun.Transpiler({ loader: "js" })

function isResolvableWithoutPackages(specifier: string): boolean {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    return true
  }
  return specifier === "bun" || specifier.startsWith("bun:") || isBuiltin(specifier)
}

export async function bareSpecifiers(path: string): Promise<readonly string[]> {
  const imports = transpiler.scanImports(await Bun.file(path).text())
  return [
    ...new Set(imports.map((entry) => entry.path).filter((s) => !isResolvableWithoutPackages(s))),
  ].sort()
}

if (import.meta.main) {
  const bundles = process.argv.slice(2)
  if (bundles.length === 0) {
    process.stderr.write("usage: assert-bundles-self-contained.ts <bundle.js>…\n")
    process.exit(64)
  }
  let failed = false
  for (const bundle of bundles) {
    const bare = await bareSpecifiers(bundle)
    if (bare.length > 0) {
      failed = true
      process.stderr.write(
        `${bundle} imports packages the runtime image does not carry: ${bare.join(", ")}\n`,
      )
    }
  }
  if (failed) process.exit(1)
  process.stdout.write(`self-contained: ${bundles.join(" ")}\n`)
}
