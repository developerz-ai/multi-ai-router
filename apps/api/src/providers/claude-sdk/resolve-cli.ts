import { join } from "node:path"

/**
 * Which `claude` binary the Agent SDK will spawn — and, just as importantly, *why that one*.
 *
 * The Agent SDK spawns a native CLI as a subprocess. That binary can arrive five different ways
 * (a pinned override, a package that materialises it in a postinstall, the SDK's own platform
 * package, a `PATH` entry, a native-installer path), and when the wrong one wins the failure is
 * indistinguishable from any other SDK error: a string on stderr about a process that would not
 * start. So resolution is an explicit, ordered ladder, and **the rung that won is reported** —
 * `/readyz` names it, boot logs it. See docs/idea/11-anthropic-agent-sdk.md#9-operational-notes.
 *
 * Two rules the order encodes:
 *
 * - **An explicit override never falls through.** If `CLAUDE_CLI_PATH` is set and unusable we
 *   fail, rather than quietly spawning some other binary the operator did not name. Silently
 *   honouring a *different* binary than the one configured is the worst outcome available.
 * - **The stub is not a binary.** `@anthropic-ai/claude-code` ships `bin/claude.exe` as a ~500-byte
 *   placeholder that its postinstall overwrites with the real, platform-native executable. A build
 *   that ran with `--ignore-scripts` leaves the placeholder in place — present, executable, and
 *   completely inert. Anything that small is rejected, so the ladder falls through to a rung that
 *   actually has a binary instead of spawning a file that cannot run.
 *
 * This module is the ladder alone: the filesystem and the module resolver arrive as an injected
 * probe (`cli-probe.ts` builds the production one), so every rung is testable without a temp
 * directory, a real 275 MB binary, or a `claude` on the test host's `PATH`.
 */

/** The rungs, in the order they are tried. */
export type CliSource =
  | "env_override"
  | "bundled_binary"
  | "platform_package"
  | "path_lookup"
  | "legacy_install"

/** Why a candidate was passed over. Each value maps to one operator action. */
export type CliRejection = "not_configured" | "unresolved" | "missing" | "not_executable" | "stub"

export interface CliAttempt {
  readonly source: CliSource
  /** The rejected candidate, or null when the rung produced no candidate at all. */
  readonly path: string | null
  readonly rejection: CliRejection
}

export type CliResolution =
  | { readonly ok: true; readonly source: CliSource; readonly path: string; readonly bytes: number }
  | { readonly ok: false; readonly attempts: readonly CliAttempt[] }

/** What the filesystem says about one candidate. `missing` also covers "exists but is not a file". */
export type FileFacts =
  | { readonly kind: "missing" }
  | { readonly kind: "not_executable" }
  | { readonly kind: "executable"; readonly bytes: number }

export interface CliProbe {
  /** `CLAUDE_CLI_PATH`, or null when the operator pinned nothing. */
  readonly override: string | null
  /** Follows symlinks on purpose: a symlink onto `PATH` is the supported install shape. */
  readonly inspect: (path: string) => FileFacts
  /**
   * Resolves a package subpath the way the Agent SDK resolves its own platform package — from the
   * SDK's directory, not ours. Under bun's store layout those are different roots and only the
   * SDK's one can see the platform package. Null when the specifier does not resolve.
   */
  readonly resolveFromSdk: (specifier: string) => string | null
  /** Resolves a package subpath from this application's node_modules root. */
  readonly resolveLocal: (specifier: string) => string | null
  readonly pathEntries: readonly string[]
  readonly homeDir: string | null
  readonly platform: string
  readonly arch: string
  /** True on a musl userland, which flips the platform-package preference order. */
  readonly preferMusl: boolean
}

const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk"
const CLI_PACKAGE = "@anthropic-ai/claude-code"

/**
 * The placeholder is 500 bytes and a real binary is hundreds of megabytes, so any threshold in
 * between works: high enough that a future stub cannot grow past it, low enough that no real build
 * is ever mistaken for one.
 */
const STUB_MAX_BYTES = 64 * 1024

export function resolveClaudeCli(probe: CliProbe): CliResolution {
  const attempts: CliAttempt[] = []

  const override = tryOverride(probe)
  if (override.ok) return override.value
  attempts.push(override.attempt)
  // An override that failed is terminal: see the module doc block.
  if (override.attempt.rejection !== "not_configured") return { ok: false, attempts }

  for (const rung of [tryBundled, tryPlatformPackage, tryPath, tryLegacy]) {
    const outcome = rung(probe)
    if (outcome.ok) return outcome.value
    attempts.push(...outcome.attempts)
  }

  return { ok: false, attempts }
}

type Rung =
  | { readonly ok: true; readonly value: Extract<CliResolution, { ok: true }> }
  | { readonly ok: false; readonly attempts: readonly CliAttempt[] }

type SingleRung =
  | { readonly ok: true; readonly value: Extract<CliResolution, { ok: true }> }
  | { readonly ok: false; readonly attempt: CliAttempt }

function tryOverride(probe: CliProbe): SingleRung {
  if (probe.override === null || probe.override.trim().length === 0) {
    return {
      ok: false,
      attempt: { source: "env_override", path: null, rejection: "not_configured" },
    }
  }
  const candidate = probe.override.trim()
  const facts = probe.inspect(candidate)
  if (facts.kind !== "executable") {
    return {
      ok: false,
      attempt: { source: "env_override", path: candidate, rejection: facts.kind },
    }
  }
  // No stub check here on purpose: an operator who names a path means that path.
  return {
    ok: true,
    value: { ok: true, source: "env_override", path: candidate, bytes: facts.bytes },
  }
}

/**
 * The CLI package's own binary, materialised over its placeholder by that package's postinstall.
 * The placeholder is `bin/claude.exe` on **every** platform, Linux included — `install.cjs` copies
 * the native binary over that exact name, so a search for `bin/claude` never resolves on POSIX.
 */
function tryBundled(probe: CliProbe): Rung {
  const specifier = `${CLI_PACKAGE}/bin/claude.exe`
  const candidate = probe.resolveLocal(specifier) ?? probe.resolveFromSdk(specifier)
  if (candidate === null) {
    return { ok: false, attempts: [attempt("bundled_binary", null, "unresolved")] }
  }
  return accept("bundled_binary", candidate, probe, { rejectStub: true })
}

/**
 * The Agent SDK's own platform package — the same candidate order, and the same `claude` subpath,
 * the SDK itself walks. This is the rung that wins in our image: the platform package is an
 * optional dependency of the SDK, so `bun install` puts the matching native binary in place.
 */
function tryPlatformPackage(probe: CliProbe): Rung {
  const attempts: CliAttempt[] = []
  for (const pkg of platformPackages(probe)) {
    const specifier = `${pkg}/${binaryName(probe.platform)}`
    const candidate = probe.resolveFromSdk(specifier) ?? probe.resolveLocal(specifier)
    if (candidate === null) {
      attempts.push(attempt("platform_package", null, "unresolved"))
      continue
    }
    const outcome = accept("platform_package", candidate, probe, { rejectStub: false })
    if (outcome.ok) return outcome
    attempts.push(...outcome.attempts)
  }
  return { ok: false, attempts }
}

function tryPath(probe: CliProbe): Rung {
  const attempts: CliAttempt[] = []
  for (const dir of probe.pathEntries) {
    if (dir.length === 0) continue
    const candidate = join(dir, binaryName(probe.platform))
    const outcome = accept("path_lookup", candidate, probe, { rejectStub: false, quiet: true })
    if (outcome.ok) return outcome
    attempts.push(...outcome.attempts)
  }
  if (attempts.length === 0) attempts.push(attempt("path_lookup", null, "unresolved"))
  // A `PATH` with fifty directories would otherwise report fifty misses; one is the information.
  return { ok: false, attempts: [attempts[attempts.length - 1] as CliAttempt] }
}

/** Where the native installer puts it when no package manager is involved. */
function tryLegacy(probe: CliProbe): Rung {
  const attempts: CliAttempt[] = []
  for (const candidate of legacyPaths(probe)) {
    const outcome = accept("legacy_install", candidate, probe, { rejectStub: false })
    if (outcome.ok) return outcome
    attempts.push(...outcome.attempts)
  }
  if (attempts.length === 0) attempts.push(attempt("legacy_install", null, "not_configured"))
  return { ok: false, attempts }
}

interface AcceptOptions {
  readonly rejectStub: boolean
  /** Suppress the `missing` attempt — used where a miss is the expected common case. */
  readonly quiet?: boolean
}

function accept(source: CliSource, path: string, probe: CliProbe, options: AcceptOptions): Rung {
  const facts = probe.inspect(path)
  if (facts.kind !== "executable") {
    const skip = options.quiet === true && facts.kind === "missing"
    return { ok: false, attempts: skip ? [] : [attempt(source, path, facts.kind)] }
  }
  if (options.rejectStub && facts.bytes <= STUB_MAX_BYTES) {
    return { ok: false, attempts: [attempt(source, path, "stub")] }
  }
  return { ok: true, value: { ok: true, source, path, bytes: facts.bytes } }
}

function attempt(source: CliSource, path: string | null, rejection: CliRejection): CliAttempt {
  return { source, path, rejection }
}

function binaryName(platform: string): string {
  return platform === "win32" ? "claude.exe" : "claude"
}

/** Mirrors the SDK's own list so we never report a rung it would not have taken. */
function platformPackages(probe: CliProbe): readonly string[] {
  const { platform, arch } = probe
  if (platform === "android") return [`${SDK_PACKAGE}-linux-${arch}-android`]
  if (platform !== "linux") return [`${SDK_PACKAGE}-${platform}-${arch}`]
  const glibc = `${SDK_PACKAGE}-linux-${arch}`
  const musl = `${glibc}-musl`
  return probe.preferMusl ? [musl, glibc] : [glibc, musl]
}

function legacyPaths(probe: CliProbe): readonly string[] {
  const name = binaryName(probe.platform)
  const system = join("/usr", "local", "bin", name)
  const home = probe.homeDir
  if (home === null) return [system]
  return [join(home, ".claude", "local", name), join(home, ".local", "bin", name), system]
}
