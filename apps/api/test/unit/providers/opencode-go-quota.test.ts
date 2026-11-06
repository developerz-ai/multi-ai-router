import { describe, expect, test } from "bun:test"
import { httpDriver } from "../../../src/providers"
import { account } from "./fixtures"

/**
 * The Go plan's usage reader. `{status, percent, resetsAt}` per window is the live shape of
 * 2026-11-06; only `percent: 0` was observed, so a non-zero value here is this reader's assumption
 * about the scale, stated in `opencode-go-quota.ts`.
 */

const AT = new Date("2026-11-06T12:00:00.000Z")
const RESET = "2026-11-06T15:00:00.000Z"

function quotaRead() {
  const found = httpDriver("opencode-go")?.quotaRead
  if (found === undefined) throw new Error("opencode-go declares no quota read")
  return found
}

const usage = (windows: object) => ({ usage: windows })
const ok = (percent: number) => ({ status: "ok", percent, resetsAt: RESET })

describe("opencode-go usage reader, refusals first", () => {
  for (const body of [
    undefined,
    { error: "nope" },
    { usage: {} },
    usage({ rolling: { status: "ok", percent: "12" } }),
    usage({ rolling: { status: "ok", percent: -1 } }),
  ]) {
    test(`refuses ${JSON.stringify(body)} whole, never half a reading`, () => {
      expect(quotaRead().read(body, AT)).toBeNull()
    })
  }

  test("a key pointed at another endpoint is never sent to the pinned usage URL", () => {
    const moved = account({ provider: "opencode-go", baseUrl: "https://proxy.example/v1" })
    expect(quotaRead().url(moved)).toBeNull()
  })

  test("a 403 is a key with no plan, not a failure; a 401 stays a failure", () => {
    expect(quotaRead().noPlanStatuses.has(403)).toBe(true)
    expect(quotaRead().noPlanStatuses.has(401)).toBe(false)
  })

  test("no reading ever claims the account is limited now", () => {
    const signal = quotaRead().read(
      usage({ rolling: { status: "rate-limited", percent: 100, resetsAt: RESET } }),
      AT,
    )
    expect(signal?.limited).toBe(false)
    expect(signal?.retryAfterSeconds).toBeUndefined()
  })
})

describe("opencode-go usage reader", () => {
  test("targets the plan endpoint on an unmoved account", () => {
    expect(
      quotaRead()
        .url(account({ provider: "opencode-go" }))
        ?.toString(),
    ).toBe("https://opencode.ai/zen/go/v1/usage")
  })

  test("rolling and weekly land on named advisory windows", () => {
    const signal = quotaRead().read(usage({ rolling: ok(25), weekly: ok(50) }), AT)

    expect(signal?.quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 0.25,
        utilizationSource: "continuous",
        resetsAt: new Date(RESET),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
      {
        window: "seven_day",
        utilization: 0.5,
        utilizationSource: "continuous",
        resetsAt: new Date(RESET),
        resetSource: "provider-reported",
        lastCheckedAt: AT,
        advisory: true,
      },
    ])
  })

  test("monthly has no named kind, so it travels under the provider's own word", () => {
    const signal = quotaRead().read(usage({ monthly: ok(10) }), AT)

    expect(signal?.quotaWindows).toEqual([])
    expect(signal?.windows).toEqual([
      {
        limiter: "monthly",
        utilization: 0.1,
        utilizationSource: "continuous",
        resetsAt: new Date(RESET),
        resetSource: "provider-reported",
      },
    ])
  })

  test("a limited window reads as spent, whatever percentage it printed", () => {
    const signal = quotaRead().read(
      usage({ rolling: { status: "rate-limited", percent: 40, resetsAt: RESET } }),
      AT,
    )
    expect(signal?.quotaWindows?.[0]?.utilization).toBe(1)
  })

  test("past 100 clamps, and an unknown status changes nothing", () => {
    const signal = quotaRead().read(
      usage({ rolling: { status: "something-new", percent: 130, resetsAt: RESET } }),
      AT,
    )
    expect(signal?.quotaWindows?.[0]?.utilization).toBe(1)
  })

  test("an unreadable reset costs the countdown, not the percentage", () => {
    const signal = quotaRead().read(
      usage({ weekly: { status: "ok", percent: 5, resetsAt: "soon" } }),
      AT,
    )
    const window = signal?.quotaWindows?.[0]
    expect(window?.utilization).toBe(0.05)
    expect(window?.resetsAt).toBeUndefined()
    expect(window?.resetSource).toBe("unknown")
  })
})
