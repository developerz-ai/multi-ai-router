import { describe, expect, test } from "bun:test"
import { DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS } from "../../src/config/env"
import { listenOptions } from "../../src/config/listen"
import { DEFAULT_STREAM_PACING } from "../../src/providers/claude-sdk/render"
import { DEFAULT_TRANSLATED_KEEPALIVE_MS } from "../../src/services/dataplane/relay-translate"

/**
 * Bun reaps an idle connection on a sweep of this granularity, so a keep-alive written every `H`
 * ms can arrive as late as `H + SWEEP` after the previous byte and still be in time only if the
 * idle timeout is longer than that. Two heartbeats is the margin, not one heartbeat plus a sweep.
 */
const BUN_SWEEP_MS = 4_000

describe("listenOptions", () => {
  test("hands Bun.serve the configured port and idle timeout, nothing invented", () => {
    expect(listenOptions({ port: 8080, serverIdleTimeoutSeconds: 60 })).toEqual({
      port: 8080,
      idleTimeout: 60,
    })
  })

  test("zero passes through as zero: the operator's 'never' is not turned into a default", () => {
    expect(listenOptions({ port: 0, serverIdleTimeoutSeconds: 0 }).idleTimeout).toBe(0)
  })
})

/**
 * The failure this pins: Bun's own default is 10 s, the SDK stream's heartbeat is 15 s, and a
 * stream that carried no client bytes for 10–14 s was closed by the listener before its first
 * ping went out — every `Failed to read … stream` on the fleet on 2026-09-07 sat on the sweep's
 * 4 s grid. Both keep-alives have to fit inside the default idle timeout with a sweep to spare,
 * and this is the test that fails when someone retunes one of the three numbers alone.
 */
describe("the server's idle clock and the stream keep-alives are one setting in three places", () => {
  const idleMs = DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS * 1_000

  test("the SDK render heartbeat fires at least twice inside the default idle timeout", () => {
    expect(DEFAULT_STREAM_PACING.heartbeatMs).toBeGreaterThan(0)
    expect(idleMs).toBeGreaterThanOrEqual(2 * DEFAULT_STREAM_PACING.heartbeatMs + BUN_SWEEP_MS)
  })

  test("the translated-relay keepalive fires at least twice inside the default idle timeout", () => {
    expect(DEFAULT_TRANSLATED_KEEPALIVE_MS).toBeGreaterThan(0)
    expect(idleMs).toBeGreaterThanOrEqual(2 * DEFAULT_TRANSLATED_KEEPALIVE_MS + BUN_SWEEP_MS)
  })
})
