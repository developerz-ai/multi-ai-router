import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { z } from "zod"
import { createCliProbe } from "../claude-sdk/cli-probe"
import { resolveClaudeCli } from "../claude-sdk/resolve-cli"
import { CLAUDE_FAST_CLI_VERSION } from "./integrity"

// Independently compared with native captures and the SDK 0.3.331 manifest (Linux x64/glibc).
const VERIFIED_BINARY = "4c00839cf46beb2b38ec310105f2d538f7f9321fe46c636299b74bcab94626b1"

/**
 * The runtime whose TLS ClientHello and header framing the calibration compared, deliberately a
 * literal: derived from `.bun-version`, a Bun bump would declare itself calibrated. A unit test
 * holds the two equal, so the bump fails there instead of silently serving over the SDK.
 */
export const CALIBRATED_BUN_VERSION = "1.4.4"

/** Boot-only calibration check against the CLI this process resolves (the staged one in the image). */
export function fastProfileAvailable(cliOverride: string | null): boolean {
  return fastProfileState(cliOverride) === "verified"
}

export function fastProfileState(
  cliOverride: string | null,
): "verified" | "override" | "runtime" | "cli" | "manifest" | "checksum" | "unavailable" {
  if (cliOverride !== null) return "override"
  if (Bun.version !== CALIBRATED_BUN_VERSION) return "runtime"
  try {
    const resolved = resolveClaudeCli(createCliProbe({ override: cliOverride }))
    if (!resolved.ok) return "cli"
    let manifestPath: string | URL
    try {
      const require = createRequire(import.meta.url)
      manifestPath = join(
        dirname(require.resolve("@anthropic-ai/claude-agent-sdk")),
        "manifest.json",
      )
    } catch {
      // The image carries no node_modules: the SDK is bundled into the API and its manifest shipped.
      manifestPath = new URL("../libexec/claude-manifest.json", import.meta.url)
    }
    const manifest = z.object({ version: z.literal(CLAUDE_FAST_CLI_VERSION) })
    if (!manifest.safeParse(JSON.parse(readFileSync(manifestPath, "utf8"))).success)
      return "manifest"
    return binaryChecksum(resolved.path) === VERIFIED_BINARY ? "verified" : "checksum"
  } catch {
    return "unavailable"
  }
}

function binaryChecksum(path: string): string {
  const fd = openSync(path, "r")
  try {
    const hash = createHash("sha256")
    const buffer = Buffer.alloc(64 * 1024)
    for (;;) {
      const length = readSync(fd, buffer)
      if (length === 0) return hash.digest("hex")
      hash.update(buffer.subarray(0, length))
    }
  } finally {
    closeSync(fd)
  }
}
