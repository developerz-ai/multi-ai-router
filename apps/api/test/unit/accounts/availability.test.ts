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
