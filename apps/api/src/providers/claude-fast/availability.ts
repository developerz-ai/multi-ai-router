import { createHash } from "node:crypto"
import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { z } from "zod"
import { createCliProbe } from "../claude-sdk/cli-probe"
import { resolveClaudeCli } from "../claude-sdk/resolve-cli"
import { CLAUDE_FAST_CLI_VERSION } from "./integrity"

// Independently compared with native captures and the SDK manifest (Linux x64/glibc).
const VERIFIED_BINARY = "bc1aad9982c7b59c7d889ff92595d61cf46e0a6eae074cb551d932a989bcd222"

/** Boot-only calibration check, including the image's staged PATH binary after dependency pruning. */
export function fastProfileAvailable(cliOverride: string | null): boolean {
  return fastProfileState(cliOverride) === "verified"
}

export function fastProfileState(
  cliOverride: string | null,
): "verified" | "override" | "runtime" | "cli" | "manifest" | "checksum" | "unavailable" {
  if (cliOverride !== null) return "override"
  if (Bun.version !== "1.4.2") return "runtime"
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
      // The image copies root node_modules, not workspace links; the SDK is bundled into the API.
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
