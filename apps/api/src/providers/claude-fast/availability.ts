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
  if (cliOverride !== null || Bun.version !== "1.4.2") return false
  try {
    const resolved = resolveClaudeCli(createCliProbe({ override: cliOverride }))
    if (!resolved.ok) return false
    const require = createRequire(import.meta.url)
    const main = require.resolve("@anthropic-ai/claude-agent-sdk")
    const manifest = z.object({ version: z.literal(CLAUDE_FAST_CLI_VERSION) })
    if (
      !manifest.safeParse(JSON.parse(readFileSync(join(dirname(main), "manifest.json"), "utf8")))
        .success
    )
      return false
    return binaryChecksum(resolved.path) === VERIFIED_BINARY
  } catch {
    return false
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
