/**
 * A streamed attempt's **error** body is bounded by the idle clock, like its success body.
 *
 * Headers stop the first-byte clock; on the success path `deadline.watch` then arms the idle clock.
 * The failure path read the error body straight off the response, unwatched, so an upstream that
 * sent `503` headers and then went silent held the attempt — and the client, and every healthy
 * sibling the chain had not reached yet — until the total stream deadline. The idle window is the
 * bound a silent upstream is owed, whichever status it opened with.
 */
import { expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { runAttempt } from "../../../src/services/dataplane/attempt"
import { account, cipher } from "./fixtures"

const IDLE_MS = 50
const TOTAL_MS = 5_000

test("an error body that goes silent ends at the idle deadline, not the total one", async () => {
  const driver = httpDriver("anthropic-api")
  if (driver == null) throw new Error("missing anthropic-api driver")
  const cryptor = cipher()
  let cancelled = false
  const hung = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"type":"error","error":{"type":"overl'))
    },
    cancel() {
      cancelled = true
    },
  })
  const started = performance.now()
  const outcome = await runAttempt({
    plan: {
      account: account("hung", { cipher: cryptor }),
      driver,
      dialect: "anthropic",
      url: new URL("https://upstream.test/v1/messages"),
      upstreamModel: "claude",
    },
    method: "POST",
    clientHeaders: new Headers(),
    body: null,
    timeoutMs: TOTAL_MS,
    stream: { firstByteMs: 1_000, idleMs: IDLE_MS, totalMs: TOTAL_MS, wallHoldMs: 5_000 },
    cipher: { decrypt: (value) => cryptor.decrypt(value) },
    fetch: async () =>
      new Response(hung, { status: 503, headers: { "content-type": "application/json" } }),
  })
  const elapsed = performance.now() - started

  expect(elapsed).toBeLessThan(TOTAL_MS / 2)
  if (outcome.kind !== "failure") throw new Error(`expected failure, got ${outcome.kind}`)
  // The status still decides the verdict: the upstream said 503 before it went quiet.
  expect(outcome.failure).toMatchObject({ kind: "server-error", status: 503 })
  expect(cancelled).toBe(true)
}, 10_000)
