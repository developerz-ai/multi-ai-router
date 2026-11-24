import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { CALIBRATED_BUN_VERSION } from "../../../src/providers/claude-fast/availability"
import { CLAUDE_FAST_CLI_VERSION } from "../../../src/providers/claude-fast/integrity"

/**
 * The fast profile is calibrated against one Bun and one CLI. A bump of either is caught here, with
 * the procedure, rather than at boot, where it only turns the whole fleet over to the SDK.
 */
const RECALIBRATE = "recalibrate: docs/research/claude-wire.md#repeat-after-an-sdkcli-update"

test("the calibrated Bun is the pinned one", () => {
  const pinned = readFileSync(resolve(".bun-version"), "utf8").trim()
  expect(`${pinned} (${RECALIBRATE})`).toBe(`${CALIBRATED_BUN_VERSION} (${RECALIBRATE})`)
})

test("the calibrated CLI is the one the pinned Agent SDK ships", () => {
  const manifest: unknown = JSON.parse(readFileSync(resolve("apps/api/package.json"), "utf8"))
  const pinned = JSON.stringify(manifest).match(/"@anthropic-ai\/claude-agent-sdk":"([^"]+)"/)?.[1]
  // SDK 0.3.x ships CLI 2.1.x of the same patch.
  expect(`${pinned?.replace(/^0\.3\./, "2.1.")} (${RECALIBRATE})`).toBe(
    `${CLAUDE_FAST_CLI_VERSION} (${RECALIBRATE})`,
  )
})
