import { describe, expect, test } from "bun:test"
import type { CliProbe, FileFacts } from "../../../src/providers"
import { resolveClaudeCli } from "../../../src/providers"

/**
 * The resolution ladder, exercised entirely through its injected probe: no temp directories, no
 * 275 MB binaries, and no dependence on whether a `claude` happens to be on the test host's `PATH`.
 */

const BINARY_BYTES = 275_012_592
/** The real placeholder `@anthropic-ai/claude-code` ships before its postinstall replaces it. */
const STUB_BYTES = 500

const SDK = "@anthropic-ai/claude-agent-sdk"
const GLIBC_BINARY = `/app/node_modules/${SDK}-linux-x64/claude`
const MUSL_BINARY = `/app/node_modules/${SDK}-linux-x64-musl/claude`
const BUNDLED = "/app/node_modules/@anthropic-ai/claude-code/bin/claude.exe"

function executable(bytes = BINARY_BYTES): FileFacts {
  return { kind: "executable", bytes }
}

/** A filesystem: anything not listed is missing, which is the common case for a rung. */
function filesystem(entries: Record<string, FileFacts>): (path: string) => FileFacts {
  const table = new Map(Object.entries(entries))
  return (path) => table.get(path) ?? { kind: "missing" }
}

/** A module resolver: maps package subpaths to the file they land on. */
function resolver(entries: Record<string, string>): (specifier: string) => string | null {
  const table = new Map(Object.entries(entries))
  return (specifier) => table.get(specifier) ?? null
}

function probe(overrides: Partial<CliProbe> = {}): CliProbe {
  return {
    override: null,
    inspect: () => ({ kind: "missing" }),
    resolveFromSdk: () => null,
    resolveLocal: () => null,
    pathEntries: [],
    homeDir: null,
    platform: "linux",
    arch: "x64",
    preferMusl: false,
    ...overrides,
  }
}

/** The shape a healthy container has: the SDK's own platform package, and nothing else. */
function platformPackageProbe(overrides: Partial<CliProbe> = {}): CliProbe {
  return probe({
    inspect: filesystem({ [GLIBC_BINARY]: executable() }),
    resolveFromSdk: resolver({ [`${SDK}-linux-x64/claude`]: GLIBC_BINARY }),
    ...overrides,
  })
}

describe("the env override", () => {
  test("wins over every other rung", () => {
    const resolution = resolveClaudeCli(
      platformPackageProbe({
        override: "/opt/custom/claude",
        inspect: filesystem({
          "/opt/custom/claude": executable(),
          [GLIBC_BINARY]: executable(),
        }),
      }),
    )

    expect(resolution).toEqual({
      ok: true,
      source: "env_override",
      path: "/opt/custom/claude",
      bytes: BINARY_BYTES,
    })
  })

  test("is terminal when unusable — it never falls through to a binary nobody named", () => {
    const resolution = resolveClaudeCli(platformPackageProbe({ override: "/opt/typo/claude" }))

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts).toEqual([
      { source: "env_override", path: "/opt/typo/claude", rejection: "missing" },
    ])
  })

  test("reports a present-but-unexecutable pin distinctly from a missing one", () => {
    const resolution = resolveClaudeCli(
      probe({
        override: "/opt/custom/claude",
        inspect: filesystem({ "/opt/custom/claude": { kind: "not_executable" } }),
      }),
    )

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts[0]?.rejection).toBe("not_executable")
  })

  test("is treated as unset when blank, and a set pin is trimmed", () => {
    expect(resolveClaudeCli(platformPackageProbe({ override: "   " })).ok).toBe(true)

    const trimmed = resolveClaudeCli(
      probe({
        override: "  /opt/custom/claude \n",
        inspect: filesystem({ "/opt/custom/claude": executable() }),
      }),
    )
    expect(trimmed.ok && trimmed.path).toBe("/opt/custom/claude")
  })

  test("accepts a small binary — an operator who names a path means that path", () => {
    const resolution = resolveClaudeCli(
      probe({
        override: "/opt/tiny/claude",
        inspect: filesystem({ "/opt/tiny/claude": executable(STUB_BYTES) }),
      }),
    )

    expect(resolution.ok && resolution.source).toBe("env_override")
  })
})

describe("the bundled-binary rung", () => {
  test("looks for bin/claude.exe on POSIX too — the package ships that one name everywhere", () => {
    const resolution = resolveClaudeCli(
      probe({
        inspect: filesystem({ [BUNDLED]: executable() }),
        resolveLocal: resolver({ "@anthropic-ai/claude-code/bin/claude.exe": BUNDLED }),
      }),
    )

    expect(resolution).toEqual({
      ok: true,
      source: "bundled_binary",
      path: BUNDLED,
      bytes: BINARY_BYTES,
    })
  })

  test("rejects the postinstall stub and falls through to the platform package", () => {
    const resolution = resolveClaudeCli(
      platformPackageProbe({
        inspect: filesystem({
          [BUNDLED]: executable(STUB_BYTES),
          [GLIBC_BINARY]: executable(),
        }),
        resolveLocal: resolver({ "@anthropic-ai/claude-code/bin/claude.exe": BUNDLED }),
      }),
    )

    expect(resolution.ok && resolution.source).toBe("platform_package")
  })

  test("records the stub rejection by name, so a --ignore-scripts build is diagnosable", () => {
    const resolution = resolveClaudeCli(
      probe({
        inspect: filesystem({ [BUNDLED]: executable(STUB_BYTES) }),
        resolveLocal: resolver({ "@anthropic-ai/claude-code/bin/claude.exe": BUNDLED }),
      }),
    )

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts).toContainEqual({
      source: "bundled_binary",
      path: BUNDLED,
      rejection: "stub",
    })
  })
})

describe("the platform-package rung", () => {
  test("resolves from the SDK's own directory in preference to ours", () => {
    const resolution = resolveClaudeCli(
      probe({
        inspect: filesystem({
          [GLIBC_BINARY]: executable(),
          "/app/other/claude": executable(),
        }),
        resolveFromSdk: resolver({ [`${SDK}-linux-x64/claude`]: GLIBC_BINARY }),
        resolveLocal: resolver({ [`${SDK}-linux-x64/claude`]: "/app/other/claude" }),
      }),
    )

    expect(resolution.ok && resolution.path).toBe(GLIBC_BINARY)
  })

  test("prefers glibc on a glibc host and musl on a musl one", () => {
    const both = {
      inspect: filesystem({ [GLIBC_BINARY]: executable(), [MUSL_BINARY]: executable() }),
      resolveFromSdk: resolver({
        [`${SDK}-linux-x64/claude`]: GLIBC_BINARY,
        [`${SDK}-linux-x64-musl/claude`]: MUSL_BINARY,
      }),
    }

    expect(resolveClaudeCli(probe(both)).ok && resolveClaudeCli(probe(both)).path).toBe(
      GLIBC_BINARY,
    )

    const musl = resolveClaudeCli(probe({ ...both, preferMusl: true }))
    expect(musl.ok && musl.path).toBe(MUSL_BINARY)
  })

  test("falls back to the other libc when the preferred package is absent", () => {
    const resolution = resolveClaudeCli(
      probe({
        preferMusl: true,
        inspect: filesystem({ [GLIBC_BINARY]: executable() }),
        resolveFromSdk: resolver({ [`${SDK}-linux-x64/claude`]: GLIBC_BINARY }),
      }),
    )

    expect(resolution.ok && resolution.path).toBe(GLIBC_BINARY)
  })

  test("names one package per non-linux platform, and claude.exe on windows", () => {
    const windows = resolveClaudeCli(
      probe({
        platform: "win32",
        arch: "arm64",
        inspect: filesystem({ "C:/app/claude.exe": executable() }),
        resolveFromSdk: resolver({ [`${SDK}-win32-arm64/claude.exe`]: "C:/app/claude.exe" }),
      }),
    )
    expect(windows.ok && windows.source).toBe("platform_package")

    const android = resolveClaudeCli(
      probe({
        platform: "android",
        arch: "arm64",
        inspect: filesystem({ "/data/claude": executable() }),
        resolveFromSdk: resolver({ [`${SDK}-linux-arm64-android/claude`]: "/data/claude" }),
      }),
    )
    expect(android.ok && android.source).toBe("platform_package")
  })

  test("treats a directory at the resolved path as missing", () => {
    const resolution = resolveClaudeCli(
      probe({
        inspect: () => ({ kind: "missing" }),
        resolveFromSdk: resolver({ [`${SDK}-linux-x64/claude`]: GLIBC_BINARY }),
      }),
    )

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts).toContainEqual({
      source: "platform_package",
      path: GLIBC_BINARY,
      rejection: "missing",
    })
  })
})

describe("the PATH rung", () => {
  test("takes the first entry that holds an executable", () => {
    const resolution = resolveClaudeCli(
      probe({
        pathEntries: ["/empty", "/usr/local/bin", "/usr/bin"],
        inspect: filesystem({
          "/usr/local/bin/claude": executable(),
          "/usr/bin/claude": executable(),
        }),
      }),
    )

    expect(resolution).toEqual({
      ok: true,
      source: "path_lookup",
      path: "/usr/local/bin/claude",
      bytes: BINARY_BYTES,
    })
  })

  test("accepts a small file: a symlink onto PATH is the supported install shape", () => {
    const resolution = resolveClaudeCli(
      probe({
        pathEntries: ["/usr/local/bin"],
        inspect: filesystem({ "/usr/local/bin/claude": executable(STUB_BYTES) }),
      }),
    )

    expect(resolution.ok && resolution.source).toBe("path_lookup")
  })

  test("collapses a long PATH of misses into a single attempt", () => {
    const resolution = resolveClaudeCli(probe({ pathEntries: ["/a", "/b", "/c", "/d", "", "/e"] }))

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    const pathAttempts = resolution.attempts.filter((a) => a.source === "path_lookup")
    expect(pathAttempts).toHaveLength(1)
  })

  test("still reports a PATH entry that exists but cannot be executed", () => {
    const resolution = resolveClaudeCli(
      probe({
        pathEntries: ["/usr/local/bin"],
        inspect: filesystem({ "/usr/local/bin/claude": { kind: "not_executable" } }),
      }),
    )

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts).toContainEqual({
      source: "path_lookup",
      path: "/usr/local/bin/claude",
      rejection: "not_executable",
    })
  })
})

describe("the legacy-install rung", () => {
  test("walks the native installer's paths in order", () => {
    const resolution = resolveClaudeCli(
      probe({
        homeDir: "/home/bun",
        inspect: filesystem({
          "/home/bun/.claude/local/claude": executable(),
          "/home/bun/.local/bin/claude": executable(),
        }),
      }),
    )

    expect(resolution.ok && resolution.path).toBe("/home/bun/.claude/local/claude")
  })

  test("checks the system path when there is no home directory", () => {
    const resolution = resolveClaudeCli(
      probe({ inspect: filesystem({ "/usr/local/bin/claude": executable() }) }),
    )

    expect(resolution).toEqual({
      ok: true,
      source: "legacy_install",
      path: "/usr/local/bin/claude",
      bytes: BINARY_BYTES,
    })
  })
})

describe("when nothing resolves", () => {
  test("reports every rung it tried, in ladder order", () => {
    const resolution = resolveClaudeCli(probe({ pathEntries: ["/usr/bin"], homeDir: "/home/bun" }))

    expect(resolution.ok).toBe(false)
    if (resolution.ok) throw new Error("unreachable")
    expect(resolution.attempts.map((a) => a.source)).toEqual([
      "env_override",
      "bundled_binary",
      "platform_package",
      "platform_package",
      "path_lookup",
      "legacy_install",
      "legacy_install",
      "legacy_install",
    ])
    expect(resolution.attempts[0]).toEqual({
      source: "env_override",
      path: null,
      rejection: "not_configured",
    })
  })
})
