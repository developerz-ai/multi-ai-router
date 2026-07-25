import { accessSync, constants, statSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { delimiter } from "node:path"
import type { CliProbe, FileFacts } from "./resolve-cli"

/**
 * The production probe the resolution ladder runs against: the real filesystem, the real module
 * resolver, this host's platform facts. Kept apart from `resolve-cli.ts` so the ladder itself
 * stays a pure function of injected facts and needs no I/O to test.
 *
 * Everything here is deliberately synchronous and best-effort. It runs at boot and behind
 * `/readyz`, never on the request path, and a probe that throws would turn "I could not tell you
 * which binary won" into "readiness crashed" — so each lookup degrades to a definite answer
 * instead: unresolvable, missing, or not executable.
 */

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"

export interface CliProbeOptions {
  /** `CLAUDE_CLI_PATH`, validated at the env boundary and passed through untouched. */
  readonly override: string | null
  /** Defaults to `process.env`. Only `PATH` is read. */
  readonly env?: NodeJS.ProcessEnv
}

export function createCliProbe(options: CliProbeOptions): CliProbe {
  const env = options.env ?? process.env
  const localRequire = createRequire(import.meta.url)
  // Resolving *from the SDK's own file* is what makes the platform-package rung work: bun installs
  // a package's own dependencies beside it in the store, where our node_modules cannot see them.
  const sdkRequire = (() => {
    try {
      return createRequire(localRequire.resolve(SDK_PACKAGE))
    } catch {
      return null
    }
  })()

  return {
    override: options.override,
    inspect: inspectFile,
    resolveFromSdk: (specifier) => tryResolve(sdkRequire, specifier),
    resolveLocal: (specifier) => tryResolve(localRequire, specifier),
    pathEntries: (env.PATH ?? "").split(delimiter),
    homeDir: safeHomeDir(),
    platform: process.platform,
    arch: process.arch,
    preferMusl: detectMusl(),
  }
}

function tryResolve(from: NodeJS.Require | null, specifier: string): string | null {
  if (from === null) return null
  try {
    return from.resolve(specifier)
  } catch {
    return null
  }
}

function inspectFile(path: string): FileFacts {
  let bytes: number
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return { kind: "missing" }
    bytes = stats.size
  } catch {
    return { kind: "missing" }
  }
  try {
    accessSync(path, constants.X_OK)
  } catch {
    return { kind: "not_executable" }
  }
  return { kind: "executable", bytes }
}

function safeHomeDir(): string | null {
  try {
    const home = homedir()
    return home.length > 0 ? home : null
  } catch {
    return null
  }
}

/**
 * `glibcVersionRuntime` is present in the Node process report on glibc and absent on musl. Cheaper
 * than spawning `ldd`, without `ldd`'s ENOENT-means-musl false positive on a stripped image, and
 * the same signal the Agent SDK uses — so we never prefer a platform package it would not have.
 */
function detectMusl(): boolean {
  if (process.platform !== "linux") return false
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } }
  return report?.header?.glibcVersionRuntime === undefined
}
