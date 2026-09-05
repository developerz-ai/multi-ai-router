import { describe, expect, test } from "bun:test"
import {
  createSdkConcurrency,
  createSessionStore,
  type SdkInvocation,
  type SdkInvoker,
} from "../../src/providers"
import type { PoolSnapshot } from "../../src/services/routing"
import { memorySessions } from "../unit/claude-sdk/fixtures"
import { subscriptionAccount } from "../unit/dataplane/fixtures"
import { bearer, harness, post, settle } from "./harness"

/**
 * The operator's shape: six Claude subscriptions in one `round-robin` pool, twenty coding agents
 * starting at once through one key scoped to that pool. Every agent is served, the new sessions
 * spread three-or-four per subscription, each conversation then stays where it landed, and nobody
 * queues on a per-account gate while the global one has room.
 *
 * The SDK is stubbed at `query()` as everywhere else; the concurrency gate is the real one, wrapped
 * around the stub exactly as the production invoker wraps the subprocess, so the queue depth it
 * reports is the depth the deployment would see.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")
const SUBS = ["sub-1", "sub-2", "sub-3", "sub-4", "sub-5", "sub-6"] as const
const POOL_ID = "claude-subs"
const AGENTS = 20

const pool: PoolSnapshot = {
  id: POOL_ID,
  name: "claude-subs",
  policy: "round-robin",
  members: SUBS.map((accountId) => ({ accountId })),
}

function turn(sessionId: string, turns: readonly { role: string; content: string }[]) {
  return post(
    JSON.stringify({ model: "claude-opus-5", max_tokens: 64, stream: true, messages: turns }),
    { ...bearer(), "x-session-id": sessionId },
  )
}

const OPENING = [{ role: "user", content: "hello" }]
const SECOND = [...OPENING, { role: "assistant", content: "hi" }, { role: "user", content: "go" }]

/** An Anthropic SSE stream, the shape the renderer emits for a streaming turn. */
function sdkStream(): Response {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-opus-5","content":[],"stop_reason":null,"usage":{"input_tokens":7,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ]
  return new Response(frames.join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

async function until(condition: () => boolean, label: string): Promise<void> {
  for (let tick = 0; tick < 200; tick += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error(`timed out waiting for ${label}`)
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

describe("twenty coding agents on six subscriptions", () => {
  test("all served, spread round-robin, held in place, and nobody waits on a per-account gate", async () => {
    const seen: SdkInvocation[] = []
    // Production's ceilings for this fleet: CLAUDE_SDK_MAX_CONCURRENCY=24, _PER_ACCOUNT=8.
    const concurrency = createSdkConcurrency({ global: 24, perAccount: 8 })
    let arrived = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let peakQueued = 0

    // The stub holds its slot across the whole turn, the way the subprocess holds a process.
    const invoke: SdkInvoker = async (invocation) => {
      const slot = await concurrency.acquire(invocation.accountId, invocation.signal)
      try {
        seen.push(invocation)
        arrived += 1
        peakQueued = Math.max(peakQueued, concurrency.queued)
        await gate
        invocation.onSession?.({
          sdkSessionId: `sess_${invocation.accountId}_${invocation.session.kind}`,
          assistantUuid: "uuid-1",
        })
        return sdkStream()
      } finally {
        slot.release()
      }
    }

    const repository = memorySessions()
    const { app, usage } = harness({
      accounts: SUBS.map((id) => subscriptionAccount(id)),
      pools: [pool],
      scope: "pools",
      poolIds: [POOL_ID],
      responses: [],
      invokeSdk: invoke,
      sessions: createSessionStore({ repository, now: () => NOW }),
      selection: { boundAccountCoolingDown: "rebind" },
    })

    const agents = Array.from({ length: AGENTS }, (_, index) => `agent-${index + 1}`)
    const inFlight = agents.map((id) => app.request("/v1/messages", turn(id, OPENING)))

    // Every agent has reached the transport and holds a slot: twenty subprocesses, no queue.
    await until(() => arrived === AGENTS, "all agents to reach the SDK")
    expect(concurrency.inFlight).toBe(AGENTS)
    expect(concurrency.queued).toBe(0)
    expect(peakQueued).toBe(0)
    for (const id of SUBS) expect(concurrency.inFlightFor(id)).toBeLessThanOrEqual(4)

    release()
    const responses = await Promise.all(inFlight)
    const bodies = await Promise.all(responses.map((res) => res.text()))
    await settle()

    // All twenty served, streamed, and none restarted — a new session has nothing to restart.
    expect(responses.map((res) => res.status)).toEqual(Array<number>(AGENTS).fill(200))
    expect(bodies.every((body) => body.includes("message_stop"))).toBe(true)
    expect(responses.every((res) => res.headers.get("x-router-session-restart") === null)).toBe(
      true,
    )
    expect(seen.every((call) => call.session.kind === "fresh")).toBe(true)

    // Round-robin over six: 20 = 6 * 3 + 2, so two subscriptions carry four and four carry three.
    const spread = countBy(seen.map((call) => call.accountId))
    expect([...spread.keys()].sort()).toEqual([...SUBS])
    expect([...spread.values()].sort()).toEqual([3, 3, 3, 3, 4, 4])
    expect(usage.rows).toHaveLength(AGENTS)
    expect(usage.rows.every((row) => row.outcome === "success" && row.poolId === POOL_ID)).toBe(
      true,
    )

    // Second turns: every agent resumes where it landed. The rotation does not move a bound
    // session, and nothing about a bound turn is a restart.
    const before = seen.length
    const seconds = await Promise.all(
      agents.map((id) => app.request("/v1/messages", turn(id, SECOND))),
    )
    await Promise.all(seconds.map((res) => res.text()))
    await settle()

    expect(seconds.every((res) => res.status === 200)).toBe(true)
    expect(seconds.every((res) => res.headers.get("x-router-session-restart") === null)).toBe(true)
    const resumed = seen.slice(before)
    expect(resumed).toHaveLength(AGENTS)
    expect(resumed.every((call) => call.session.kind === "resume")).toBe(true)
    expect(countBy(resumed.map((call) => call.accountId))).toEqual(spread)
    expect(concurrency.inFlight).toBe(0)
    expect(concurrency.queued).toBe(0)
  })

  test("under priority-failover the same fleet piles onto one subscription and queues at its gate", async () => {
    // The shape the operator runs today. Not a bug — `priority-failover` concentrates by design —
    // but it is why twenty agents wait behind `CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT=8` while
    // sixteen global slots sit idle. `round-robin` (above) or `sticky` is the policy for a fleet.
    const concurrency = createSdkConcurrency({ global: 24, perAccount: 8 })
    let arrived = 0
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const invoke: SdkInvoker = async (invocation) => {
      const slot = await concurrency.acquire(invocation.accountId, invocation.signal)
      try {
        arrived += 1
        await gate
        return sdkStream()
      } finally {
        slot.release()
      }
    }

    const { app } = harness({
      accounts: SUBS.map((id, index) => subscriptionAccount(id, { snapshot: { priority: index } })),
      pools: [{ ...pool, policy: "priority-failover" }],
      scope: "pools",
      poolIds: [POOL_ID],
      responses: [],
      invokeSdk: invoke,
    })

    const inFlight = Array.from({ length: AGENTS }, (_, index) =>
      app.request("/v1/messages", turn(`agent-${index + 1}`, OPENING)),
    )
    await until(() => arrived === 8, "the per-account gate to fill")
    await settle()

    expect(concurrency.inFlightFor("sub-1")).toBe(8)
    expect(concurrency.inFlight).toBe(8)
    // Twelve agents queued on `sub-1`'s gate with sixteen global permits free.
    expect(concurrency.queued).toBe(AGENTS - 8)

    release()
    const responses = await Promise.all(inFlight)
    await Promise.all(responses.map((res) => res.text()))
    expect(responses.every((res) => res.status === 200)).toBe(true)
  })
})
