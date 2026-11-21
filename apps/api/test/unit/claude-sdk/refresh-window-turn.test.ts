import { describe, expect, test } from "bun:test"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import {
  type CliResolution,
  createSdkConcurrency,
  createSdkInvoker,
  type SdkQueryFn,
} from "../../../src/providers"
import {
  type CredentialFreshnessDeps,
  createCredentialFreshness,
} from "../../../src/providers/claude-sdk/credential-freshness"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import { CredentialRefreshLeaseUnavailable } from "../../../src/providers/claude-sdk/ownership-errors"
import { sdkQueryStream, sdkTurn } from "./fixtures"

/**
 * The real invoker against the real refresh-window gate (101 findings 05.1 / 10.10 and 05.5).
 *
 * Prod fingerprint (10.10): at every access-token expiry the first request inside the CLI's refresh
 * lead logged a warning with `waitedMs` ≈ 20 000 and admitted a caller that should have refused
 * — it was waiting on its own claim, re-asked once its slot was granted. The second half is the
 * busy-session retry: the first attempt's late epilogue must not release the retry's claim.
 */

const ACCOUNT = "3f1c0a6e-2b7d-4a51-9c88-0d21e5b7a410"
const CONFIG_DIR = `/data/claude/${ACCOUNT}`
const NOW_MS = 1_788_000_000_000
const CLI: CliResolution = {
  ok: true,
  source: "platform_package",
  path: "/opt/claude/claude",
  bytes: 1,
}
const ONE_TURN = sdkTurn({
  blocks: [
    [
      { type: "text", text: "" },
      { type: "text_delta", text: "pong" },
    ],
  ],
})

/** A token 60 s from expiry: inside the 300 s skew, so every spawn enters the refresh window. */
const EXPIRING: CredentialMetadata = {
  refreshTokenExpiresAt: new Date(NOW_MS + 30 * 86_400_000),
  accessTokenExpiresAt: new Date(NOW_MS + 60_000),
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
  hasTokens: true,
}

function gate(
  refreshLock?: CredentialFreshnessDeps["refreshLock"],
  read: () => CredentialMetadata = () => EXPIRING,
  sleep?: CredentialFreshnessDeps["sleep"],
) {
  // Existing turn tests own the window explicitly; give them a real, stateful lease unless a test
  // injects one shared with another router instance. A no-op release would leave the lease held
  // forever and turn the next admission into a cap-timeout.
  const lock = refreshLock ?? sharedLease().lock
  let clock = NOW_MS
  const sleeps: number[] = []
  const warnings: string[] = []
  const deps: CredentialFreshnessDeps = {
    reader: { read: async () => read() },
    refreshLock: lock,
    configDirs: { pathFor: (id) => `/data/claude/${id}` },
    skewMs: 300_000,
    coldMarginMs: 600_000,
    maxWaitMs: 20_000,
    pollMs: 250,
    now: () => new Date(clock),
    sleep:
      sleep ??
      (async (ms) => {
        sleeps.push(ms)
        clock += ms
      }),
    logger: {
      warn: (message: string) => warnings.push(message),
      info: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as CredentialFreshnessDeps["logger"],
  }
  return { freshness: createCredentialFreshness(deps), sleeps, warnings }
}

function body(value: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      model: "claude-opus-5",
      messages: [{ role: "user", content: "ping" }],
      ...value,
    }),
  )
}

function drainPrompt(prompt: AsyncIterable<unknown>): void {
  void (async () => {
    for await (const _ of prompt) {
      /* the invoker holds the prompt open past `result` */
    }
  })()
}

const never = new AbortController().signal

/**
 * Two router instances, one account, one cross-replica lease. The lock fake counts every lease
 * grant; each grant is the one admission allowed to spend the rotating refresh token. A refresh
 * exchange is counted at the CLI spawn, so exactly one claim must mean exactly one exchange.
 */
function sharedLease() {
  let held = false
  let claims = 0
  let releases = 0
  return {
    get claims() {
      return claims
    },
    get releases() {
      return releases
    },
    lock: {
      tryAcquire: async () => {
        if (held) return { acquired: false as const, reason: "busy" as const }
        held = true
        claims += 1
        return {
          acquired: true as const,
          lease: {
            release: async () => {
              if (!held) return
              held = false
              releases += 1
            },
          },
        }
      },
    } satisfies NonNullable<CredentialFreshnessDeps["refreshLock"]>,
  }
}

describe("concurrent refresh turns on one account across two router instances", () => {
  test("produces one refresh exchange when the second replica reacquires after the first releases", async () => {
    const lease = sharedLease()
    let metadata = EXPIRING
    const a = gate(lease.lock, () => metadata)
    let parked = (): void => {}
    const parkedBehindOwner = new Promise<void>((resolve) => {
      parked = resolve
    })
    let resumeAfterRelease = (): void => {}
    const leaseReleased = new Promise<void>((resolve) => {
      resumeAfterRelease = resolve
    })
    // Replica B must remain parked behind A's real shared lease until A's controlled refresh has
    // updated the one metadata file both replicas read. An instant clock fake would run B to its cap.
    const b = gate(
      lease.lock,
      () => metadata,
      async () => {
        parked()
        await leaseReleased
      },
    )
    let releaseRefresh = (): void => {}
    const refreshComplete = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    let exchanges = 0
    let queries = 0
    let refreshStarted = (): void => {}
    const refreshStartedPromise = new Promise<void>((resolve) => {
      refreshStarted = resolve
    })
    const runQuery: SdkQueryFn = ({ prompt }) => {
      queries += 1
      drainPrompt(prompt)
      if (metadata.accessTokenExpiresAt?.getTime() === EXPIRING.accessTokenExpiresAt?.getTime()) {
        exchanges += 1
        refreshStarted()
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "system", subtype: "init", session_id: "sess_1" }
            await refreshComplete
            for (const event of ONE_TURN) yield event
            yield { type: "result", subtype: "success" }
          },
        }
      }
      return sdkQueryStream({ turns: [ONE_TURN] })
    }
    const invokeA = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      freshness: a.freshness,
      runQuery,
      resolveCli: () => CLI,
    })
    const invokeB = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      freshness: b.freshness,
      runQuery,
      resolveCli: () => CLI,
    })
    const request = {
      accountId: ACCOUNT,
      configDir: CONFIG_DIR,
      model: "claude-opus-5",
      body: body({}),
      signal: never,
      session: { kind: "fresh" as const, reason: "no-session" as const },
    }

    // A owns the shared lease and reaches its controlled refresh. B reads the same stale metadata,
    // loses the same lease, and parks rather than progressing to its own refresh exchange.
    const first = invokeA(request)
    await refreshStartedPromise
    const second = invokeB(request)
    await parkedBehindOwner

    expect(exchanges).toBe(1)
    expect(queries).toBe(1)

    // This is the CLI's durable write: it lands before A's stream ends and its lease is released.
    // B then reacquires the shared lease, sees the fresh expiry, and may run a normal turn without
    // spending the rotating refresh token a second time.
    metadata = { ...EXPIRING, accessTokenExpiresAt: new Date(NOW_MS + 8 * 3_600_000) }
    releaseRefresh()
    const firstResponse = await Promise.allSettled([first])
    resumeAfterRelease()
    const secondResponse = await Promise.allSettled([second])
    const statuses = [...firstResponse, ...secondResponse].map((result) =>
      result.status === "fulfilled" ? result.value.status : "rejected",
    )
    expect(statuses).toEqual([200, 200])
    // B reacquired after A released, so this covers the path the prior permanently-busy fake hid.
    expect(lease.claims).toBe(2)
    expect(exchanges).toBe(1)
    expect(queries).toBe(2)
    expect(b.warnings).toEqual([])
    expect(lease.releases).toBe(2)
  })
})

describe("a turn that starts inside the refresh window", () => {
  test("owns the window and spawns with no wait and no 'did not land' warn", async () => {
    const { freshness, sleeps, warnings } = gate()
    const launched: Options[] = []
    const runQuery: SdkQueryFn = ({ prompt, options }) => {
      launched.push(options)
      drainPrompt(prompt)
      return sdkQueryStream({ turns: [ONE_TURN] })
    }
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      freshness,
      runQuery,
      resolveCli: () => CLI,
    })

    const response = await invoke({
      accountId: ACCOUNT,
      configDir: CONFIG_DIR,
      model: "claude-opus-5",
      body: body({}),
      signal: never,
      session: { kind: "fresh", reason: "no-session" },
    })

    expect(response.status).toBe(200)
    expect(launched).toHaveLength(1)
    expect(sleeps).toEqual([])
    expect(warnings).toEqual([])
  })

  test("a second caller still waits behind the owner: the window keeps exactly one owner", async () => {
    const { freshness, sleeps } = gate()
    const owner = await freshness.ensureFresh(ACCOUNT, never)
    const recheck = await freshness.ensureFresh(ACCOUNT, never, owner)
    expect(sleeps).toEqual([])

    await expect(freshness.ensureFresh(ACCOUNT, never)).rejects.toThrow(
      /refresh did not land|lease unavailable/,
    )
    expect(sleeps.length).toBeGreaterThan(0)
    recheck.release()
    owner.release()
  })

  test("a released claim no longer short-circuits: the re-ask competes like anyone else", async () => {
    const { freshness, sleeps } = gate()
    const owner = await freshness.ensureFresh(ACCOUNT, never)
    owner.release()
    const next = await freshness.ensureFresh(ACCOUNT, never, owner)
    expect(sleeps).toEqual([])
    // It owns afresh, so a third caller waits on its lease and then refuses rather than being
    // admitted on the strength of the local entry alone.
    await expect(freshness.ensureFresh(ACCOUNT, never)).rejects.toThrow(
      /refresh did not land|lease unavailable/,
    )
    expect(sleeps.length).toBeGreaterThan(0)
    next.release()
  })
})

describe("a busy-session retry keeps its own claim", () => {
  test("the first attempt's late epilogue does not release the retry's claim", async () => {
    const { freshness, sleeps } = gate()
    let closeFirst = (): void => {}
    const firstClosed = new Promise<void>((resolve) => {
      closeFirst = resolve
    })
    let finishRetry = (): void => {}
    const retryHeld = new Promise<void>((resolve) => {
      finishRetry = resolve
    })
    let call = 0
    const runQuery: SdkQueryFn = ({ prompt }) => {
      drainPrompt(prompt)
      call += 1
      if (call === 1) {
        // Busy refusal, and a `return()` that settles only when the test says so.
        return {
          [Symbol.asyncIterator]: () => ({
            next: () =>
              Promise.reject(
                new Error("Session sess_9 is currently running as a background agent"),
              ),
            return: async () => {
              await firstClosed
              return { done: true, value: undefined }
            },
          }),
        }
      }
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: "system", subtype: "init", session_id: "sess_9" }
          for (const event of ONE_TURN) yield event
          await retryHeld
          yield { type: "result", subtype: "success" }
        },
      }
    }
    const invoke = createSdkInvoker({
      concurrency: createSdkConcurrency({ global: 4, perAccount: 2 }),
      freshness,
      runQuery,
      resolveCli: () => CLI,
    })

    const response = await invoke({
      accountId: ACCOUNT,
      configDir: CONFIG_DIR,
      model: "claude-opus-5",
      body: body({ stream: true }),
      signal: never,
      session: { kind: "resume", sdkSessionId: "sess_9", lineage: "continuation", deltaFrom: 0 },
    })
    expect(response.status).toBe(200)
    expect(call).toBe(2)

    // Attempt 1's epilogue lands now, while the retry's CLI is mid-turn.
    closeFirst()
    await new Promise((resolve) => setTimeout(resolve, 0))

    // A newcomer must still find the retry owning the window, wait behind its lease and then
    // refuse: it is never admitted on the strength of a local entry alone.
    const before = sleeps.length
    await expect(freshness.ensureFresh(ACCOUNT, never)).rejects.toBeInstanceOf(
      CredentialRefreshLeaseUnavailable,
    )
    expect(sleeps.length).toBeGreaterThan(before)

    finishRetry()
    await response.text()
  })
})
