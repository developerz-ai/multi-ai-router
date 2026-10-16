import { fastProfileState } from "./availability"

// Run against the final image layout, after dependency pruning and COPYs.
const expected = process.platform === "linux" && process.arch === "x64"
const state = fastProfileState(null)
const available = state === "verified"
if (available !== expected)
  throw new Error(
    `packaged Claude fast profile availability does not match the calibrated platform: ${state}`,
  )
process.stdout.write(
  `${JSON.stringify({ component: "claude-fast", available, expected, state })}\n`,
)
