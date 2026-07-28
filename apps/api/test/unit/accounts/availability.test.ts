import { describe, expect, test } from "bun:test"
import type { QuotaWindowState } from "@multi-ai-router/core"
import { withAvailability } from "../../../src/services/accounts/availability"
import type { AccountsService } from "../../../src/services/accounts/service"
import type { AccountView } from "../../../src/services/accounts/view"
import { ok } from "../../../src/services/admin/result"
import {
  createHealthStore,
  type RoutableAccount,
  type RoutingCatalog,
} from "../../../src/services/dataplane"

// The availability overlay, and specifically the per-window quota it carries.
//
// The console's whole quota screen is downstream of this shape, and two of its rules are decided
// here rather than in a template: `spent` comes from `isWindowSpent` — the same pure function
// candidate filtering calls, so the console cannot disagree with the router about which window is
// blocking — and an absent utilization stays `null` rather than becoming `0`, because a source
// that reported nothing has said nothing and a zero reads as "wide open".

const NOW = new Date("2026-07-25T12:00:00.000Z")
const LATER = new Date(NOW.getTime() + 3_600_000)
const EARLIER = new Date(NOW.getTime() - 3_600_000)
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111"

function view(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: ACCOUNT_ID,
    label: "claude one",
    provider: "anthropic-oauth",
    status: "active",
    hasCredential: false,
    configDir: "/data/claude/one",
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 1,
    priority: 0,
    tokenExpiresAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

function routable(quotaWindows?: readonly QuotaWindowState[]): RoutableAccount {
  return {
    id: ACCOUNT_ID,
    snapshot: {
      id: ACCOUNT_ID,
      label: "claude one",
      provider: "anthropic-oauth",
      status: "active",
      weight: 1,
      priority: 0,
      health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
      ...(quotaWindows === undefined ? {} : { quotaWindows }),
    },
    driver: {
      id: ACCOUNT_ID,
      provider: "anthropic-oauth",
      baseUrl: null,
      dialect: null,
      modelAliases: null,
    },
    authMaterial: null,
    configDir: "/data/claude/one",
  }
}

function catalogOf(accounts: readonly RoutableAccount[]): RoutingCatalog {
  return { accounts: () => accounts, pools: () => [] }
}

/** Only `list` and `get` are decorated; the rest are never reached by these cases. */
function serviceOf(views: readonly AccountView[]): AccountsService {
  const unreachable = () => {
    throw new Error("not part of the read path")
  }
  return {
    list: async () => ok(views),
    get: async () => (views[0] === undefined ? unreachable() : ok(views[0])),
    create: unreachable,
    update: unreachable,
    disable: unreachable,
    remove: unreachable,
  }
}

function decorate(
  accounts: readonly RoutableAccount[],
  views: readonly AccountView[] = [view()],
): AccountsService {
  return withAvailability(serviceOf(views), {
    catalog: catalogOf(accounts),
    health: createHealthStore(),
    recheck: { lastCheckedAt: () => undefined },
    now: () => NOW,
  })
}

async function firstAvailability(accounts: readonly RoutableAccount[]) {
  const result = await decorate(accounts).list({})
  if (!result.ok) throw new Error("the read path must not fail here")
  return result.value[0]?.availability
}

const FIVE_HOUR: QuotaWindowState = {
  window: "five_hour",
  utilization: 0.62,
  utilizationSource: "continuous",
  resetsAt: LATER,
  resetSource: "provider-reported",
  lastCheckedAt: NOW,
}

describe("the quota windows on an account read", () => {
  test("carries one entry per window the router holds a reading for", async () => {
    const availability = await firstAvailability([
      routable([FIVE_HOUR, { ...FIVE_HOUR, window: "seven_day", utilization: 0.2 }]),
    ])

    expect(availability?.quotaWindows.map((window) => window.window)).toEqual([
      "five_hour",
      "seven_day",
    ])
  })

  test("is an empty list, never absent, for an account with no windows", async () => {
    const availability = await firstAvailability([routable()])
    expect(availability?.quotaWindows).toEqual([])
  })

  test("keeps an unreported utilization null rather than collapsing it to zero", async () => {
    const availability = await firstAvailability([
      routable([
        {
          window: "seven_day",
          utilizationSource: "threshold-triggered",
          resetSource: "unknown",
          lastCheckedAt: NOW,
        },
      ]),
    ])

    expect(availability?.quotaWindows[0]?.utilization).toBeNull()
    expect(availability?.quotaWindows[0]?.utilizationSource).toBe("threshold-triggered")
  })

  test("carries every reset instant with its source, never alone", async () => {
    const availability = await firstAvailability([routable([FIVE_HOUR])])

    expect(availability?.quotaWindows[0]?.resetsAt).toBe(LATER.toISOString())
    expect(availability?.quotaWindows[0]?.resetSource).toBe("provider-reported")
  })

  test("shows the reading this process observed, ahead of the row it was hydrated from", async () => {
    // The console is a read of the same snapshot the router routes on. A reading that arrived a
    // second ago has not been persisted yet, and a gauge that waits for the flush is a gauge that
    // tells an operator an account is fine while the router is already filtering it out.
    const health = createHealthStore()
    health.applyRateLimit(
      ACCOUNT_ID,
      {
        limited: false,
        resetSource: "provider-reported",
        windows: [],
        quotaWindows: [{ ...FIVE_HOUR, utilization: 1 }],
      },
      NOW,
    )

    const service = withAvailability(serviceOf([view()]), {
      catalog: catalogOf([routable([FIVE_HOUR])]),
      health,
      recheck: { lastCheckedAt: () => undefined },
      now: () => NOW,
    })
    const result = await service.list({})
    if (!result.ok) throw new Error("the read path must not fail here")

    expect(result.value[0]?.availability?.quotaWindows).toEqual([
      {
        window: "five_hour",
        utilization: 1,
        utilizationSource: "continuous",
        // Both null: no ceiling configured, so there is nothing for the console to draw a
        // measured bar from — and inventing a zero would read as a wide-open window.
        tokensUsed: null,
        tokenLimit: null,
        tokenSeries: [],
        resetsAt: LATER.toISOString(),
        resetSource: "provider-reported",
        lastCheckedAt: NOW.toISOString(),
        spent: true,
      },
    ])
  })

  test("reports `unknown` as the source when no instant was reported", async () => {
    const availability = await firstAvailability([
      routable([{ ...FIVE_HOUR, resetsAt: undefined, resetSource: "unknown" }]),
    ])

    expect(availability?.quotaWindows[0]?.resetsAt).toBeNull()
    expect(availability?.quotaWindows[0]?.resetSource).toBe("unknown")
  })
})

describe("the spent verdict", () => {
  test("marks a window the router would filter on", async () => {
    const availability = await firstAvailability([
      routable([{ ...FIVE_HOUR, utilization: 1, resetsAt: LATER }]),
    ])

    expect(availability?.quotaWindows[0]?.spent).toBe(true)
  })

  test("clears once the reported reset has passed — a refilled window blocks nothing", async () => {
    const availability = await firstAvailability([
      routable([{ ...FIVE_HOUR, utilization: 1, resetsAt: EARLIER }]),
    ])

    expect(availability?.quotaWindows[0]?.spent).toBe(false)
  })

  test("stays false with headroom left", async () => {
    const availability = await firstAvailability([routable([FIVE_HOUR])])
    expect(availability?.quotaWindows[0]?.spent).toBe(false)
  })

  test("stays false where nothing was reported — absent is not spent", async () => {
    const availability = await firstAvailability([
      routable([{ ...FIVE_HOUR, utilization: undefined }]),
    ])

    expect(availability?.quotaWindows[0]?.spent).toBe(false)
  })
})

describe("an account the warm catalog has not caught up with", () => {
  test("gets no availability at all rather than an invented one", async () => {
    const result = await decorate([]).list({})
    if (!result.ok) throw new Error("the read path must not fail here")
    expect(result.value[0]?.availability).toBeUndefined()
  })
})

describe("a single-account read", () => {
  test("carries the same windows the list does", async () => {
    const result = await decorate([routable([FIVE_HOUR])]).get(ACCOUNT_ID)
    if (!result.ok) throw new Error("the read path must not fail here")
    expect(result.value.availability?.quotaWindows).toHaveLength(1)
  })
})

/**
 * The measured fallback: tokens THIS ROUTER recorded, against a ceiling the OPERATOR configured.
 *
 * It exists because Anthropic publishes no numeric limit and its SDK reports a utilization only
 * near a window's edge, so for most of every window the console has nothing to draw. The property
 * that makes it correct rather than merely useful is the **span**: a window's usage is counted from
 * `resetsAt - span`, not from "N hours ago", and those two ranges differ by however long ago the
 * window opened.
 */
describe("measuring a window against a configured ceiling", () => {
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000

  function measured(options: {
    readonly limits?: Record<string, number> | null
    readonly resetsAt?: Date
  }) {
    const spans: { accountId: string; window: string; since: Date }[] = []
    const window = {
      window: "five_hour" as const,
      utilization: undefined,
      utilizationSource: "threshold-triggered" as const,
      resetsAt: options.resetsAt ?? new Date(NOW.getTime() + 60 * 60 * 1_000),
      resetSource: "provider-reported" as const,
      lastCheckedAt: NOW,
    }

    const service = withAvailability(
      serviceOf([{ ...view(), windowTokenLimits: options.limits ?? null } as never]),
      {
        catalog: catalogOf([routable([window])]),
        health: createHealthStore(),
        recheck: { lastCheckedAt: () => undefined },
        now: () => NOW,
        usage: {
          tokensSince: async (input) => {
            spans.push(...input.map((s) => ({ ...s })))
            return input.map((s) => ({ accountId: s.accountId, window: s.window, tokens: 1_500 }))
          },
        },
      },
    )

    return { service, spans }
  }

  test("counts from the window's own start, not from N hours before now", async () => {
    // Resets in one hour, so this five-hour window opened four hours ago. Counting "the last five
    // hours" would sweep in an hour that belongs to the previous window.
    const resetsAt = new Date(NOW.getTime() + 60 * 60 * 1_000)
    const { service, spans } = measured({ limits: { five_hour: 3_000 }, resetsAt })

    await service.list({})

    expect(spans).toHaveLength(1)
    expect(spans[0]?.since).toEqual(new Date(resetsAt.getTime() - FIVE_HOURS_MS))
  })

  test("reports the count and the ceiling, leaving the provider's own reading null", async () => {
    const { service } = measured({ limits: { five_hour: 3_000 } })

    const result = await service.list({})
    if (!result.ok) throw new Error("the read path must not fail here")
    const window = result.value[0]?.availability?.quotaWindows[0]

    expect(window?.tokensUsed).toBe(1_500)
    expect(window?.tokenLimit).toBe(3_000)
    // Still null: this is our arithmetic, and `utilization` is reserved for what the provider said.
    expect(window?.utilization).toBeNull()
  })

  test("an account with no configured ceiling costs no query at all", async () => {
    const { service, spans } = measured({ limits: null })

    await service.list({})

    expect(spans).toEqual([])
  })

  test("a window the operator did not configure is not measured", async () => {
    const { service, spans } = measured({ limits: { seven_day: 9_000 } })

    await service.list({})

    expect(spans).toEqual([])
  })
})
