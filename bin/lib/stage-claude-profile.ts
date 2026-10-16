import { copyFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// Resolve while the workspace link exists; the runtime ships a bundled SDK and root deps only.
const require = createRequire(new URL("../../apps/api/package.json", import.meta.url))
const sdk = require.resolve("@anthropic-ai/claude-agent-sdk")
await copyFile(join(dirname(sdk), "manifest.json"), "dist/libexec/claude-manifest.json")
