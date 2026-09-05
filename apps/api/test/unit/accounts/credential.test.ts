import { describe, expect, test } from "bun:test"
import type { AccountRow } from "@multi-ai-router/db"
import type { CredentialMetadata } from "../../../src/providers/claude-sdk/credential-metadata"
import {
  createCredentialPark,
  withCredentialMetadata,
} from "../../../src/services/accounts/credential"
import type { AccountsService } from "../../../src/services/accounts/service"
import type { AccountView } from "../../../src/services/accounts/view"
import type { AuditEventInput } from "../../../src/services/admin/audit"
import { ok } from "../../../src/services/admin/result"
import { createMemoryConfigDirs } from "../../support/config-dirs"

/**
 * The credential overlay: what a subscription account's read says about its login's expiry, when
 * that read is allowed to park the row, and — above all — that nothing token-shaped is ever in it.
 */

const NOW = new Date("2026-09-05T12:00:00.000Z")
const EXPIRES = new Date("2026-10-03T09:30:00.000Z")
const SUB_ID = "11111111-1111-4111-8111-111111111111"
const KEY_ID = "22222222-2222-4222-8222-222222222222"
const FAKE_TOKEN = "sk-ant-oat01-FAKEFAKEFAKEFAKEFAKE-not-a-real-token"

const LIVE: CredentialMetadata = {
  refreshTokenExpiresAt: EXPIRES,
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
  hasTokens: true,
}
const DEAD: CredentialMetadata = { ...LIVE, hasTokens: false }

function view(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: SUB_ID,
    label: "claude one",
    provider: "anthropic-oauth",
    status: "active",
    hasCredential: false,
    configDir: `/data/claude/${SUB_ID}`,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    weight: 1,
    priority: 0,
    billing: "subscription",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  }
}

const API_KEY_VIEW = view({
  id: KEY_ID,
  label: "openai key",
  provider: "openai-api",
  configDir: null,
  hasCredential: true,
  billing: "metered",
})

/** Reads `views` lazily, so a test can swap a row out between two reads the way a reconnect does. */
function serviceOf(views: readonly AccountView[]): AccountsService {
  const unreachable = () => {
    throw new Error("not part of the read path")
  }
  return {
    list: async () => ok([...views]),
    get: async (id) => {
      const found = views.find((entry) => entry.id === id)
      return found === undefined ? unreachable() : ok(found)
    },
    create: unreachable,
    update: unreachable,
    disable: unreachable,
    remove: unreachable,
  }
}

interface Harness {
  readonly service: AccountsService
  readonly reads: string[]
  readonly parked: string[]
  readonly logs: string[]
  /** Moves the clock; every read after uses the new instant. */
  tick(ms: number): void
}

function harness(
  views: readonly AccountView[],
  answer: () => CredentialMetadata | Promise<CredentialMetadata>,
  options: { ttlMs?: number; park?: boolean; parkResult?: boolean } = {},
): Harness {
  let clock = NOW.getTime()
  const reads: string[] = []
  const parked: string[] = []
  const logs: string[] = []
  const log = (level: string) => (msg: string) => {
    logs.push(`${level} ${msg}`)
  }
  const service = withCredentialMetadata(serviceOf(views), {
    reader: {
      read: async (configDir) => {
        reads.push(configDir)
        return answer()
      },
    },
    configDirs: createMemoryConfigDirs().dirs,
    ttlMs: options.ttlMs ?? 60_000,
    now: () => new Date(clock),
    ...(options.park === false
      ? {}
      : {
          park: async (accountId: string) => {
            parked.push(accountId)
            return options.parkResult ?? true
          },
        }),
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
      child() {
        return this
      },
    },
  })
  return {
    service,
    reads,
    parked,
    logs,
    tick: (ms) => {
      clock += ms
    },
  }
}

async function listed(service: AccountsService): Promise<readonly AccountView[]> {
  const result = await service.list({})
  if (!result.ok) throw new Error("the read path must not fail here")
  return result.value
}

describe("the credential field on an account read", () => {
  test("a subscription account carries expiry, plan, tier and presence", async () => {
    const [account] = await listed(harness([view()], () => LIVE).service)

    expect(account?.credential).toEqual({
      expiresAt: EXPIRES.toISOString(),
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      present: true,
    })
    expect(account?.status).toBe("active")
  })

  test("a non-subscription provider gets null and no read", async () => {
    const { service, reads } = harness([API_KEY_VIEW], () => LIVE)
    const [account] = await listed(service)

    expect(account?.credential).toBeNull()
    expect(reads).toEqual([])
  })

  test("reads the account's own config directory", async () => {
    const { service, reads } = harness([view()], () => LIVE)
    await listed(service)
    expect(reads).toEqual([`/data/claude/${SUB_ID}`])
  })

  test("get is decorated the same way as list", async () => {
    const result = await harness([view()], () => LIVE).service.get(SUB_ID)
    expect(result.ok && result.value.credential?.present).toBe(true)
  })

  test("a file with no expiry reads as unknown rather than 1970", async () => {
    const [account] = await listed(
      harness([view()], () => ({ ...LIVE, refreshTokenExpiresAt: null })).service,
    )
    expect(account?.credential?.expiresAt).toBeNull()
    expect(account?.credential?.present).toBe(true)
  })
})

describe("the per-account cache", () => {
  test("a second read inside the ttl does not open the file again", async () => {
    const { service, reads } = harness([view()], () => LIVE)
    await listed(service)
    await listed(service)
    expect(reads).toHaveLength(1)
  })

  test("a read after the ttl does", async () => {
    const { service, reads, tick } = harness([view()], () => LIVE, { ttlMs: 1_000 })
    await listed(service)
    tick(1_000)
    await listed(service)
    expect(reads).toHaveLength(2)
  })

  test("a cached dead result is re-read against an active row, so a reconnect is never parked", async () => {
    const views: AccountView[] = [view({ status: "needs_reauth" })]
    let answer = DEAD
    const { service, reads, parked } = harness(views, () => answer)
    await listed(service) // cached: dead, row already parked — nothing to do
    expect(parked).toEqual([])

    // The operator reconnects inside the ttl: the row is `active` again and the file holds tokens.
    views[0] = view()
    answer = LIVE
    const [account] = await listed(service)

    // Same decorator instance, same stale cache, row now active: the disk decides, not the cache.
    expect(reads).toHaveLength(2)
    expect(parked).toEqual([])
    expect(account?.status).toBe("active")
    expect(account?.credential?.present).toBe(true)
  })

  test("a cached dead result against a parked row is trusted", async () => {
    const { service, reads } = harness([view({ status: "needs_reauth" })], () => DEAD)
    await listed(service)
    await listed(service)
    expect(reads).toHaveLength(1)
  })
})

describe("parking a dead login", () => {
  test("blank tokens on an active row park it once and the view says needs_reauth", async () => {
    const { service, parked, logs } = harness([view()], () => DEAD)
    const [account] = await listed(service)

    expect(parked).toEqual([SUB_ID])
    expect(account?.status).toBe("needs_reauth")
    expect(account?.credential).toEqual({
      expiresAt: EXPIRES.toISOString(),
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      present: false,
    })
    expect(logs).toEqual(["info claude credential expired, account parked"])
  })

  test("decides against the stored status when availability overlaid a live one", async () => {
    const overlaid = view({
      status: "cooling_down",
      availability: {
        configuredStatus: "active",
        resetsAt: null,
        resetSource: "unknown",
        lastCheckedAt: null,
        consecutiveFailures: 0,
        inFlight: 0,
        quotaWindows: [],
      },
    })
    const { service, parked } = harness([overlaid], () => DEAD)
    const [account] = await listed(service)

    expect(parked).toEqual([SUB_ID])
    expect(account?.status).toBe("needs_reauth")
  })

  test("an already parked row is not parked again", async () => {
    const { service, parked } = harness([view({ status: "needs_reauth" })], () => DEAD)
    const [account] = await listed(service)
    expect(parked).toEqual([])
    expect(account?.status).toBe("needs_reauth")
    expect(account?.credential?.present).toBe(false)
  })

  test("a disabled row is the operator's and is left alone", async () => {
    const { service, parked } = harness([view({ status: "disabled" })], () => DEAD)
    const [account] = await listed(service)
    expect(parked).toEqual([])
    expect(account?.status).toBe("disabled")
  })

  test("a park that found the row no longer active leaves the view as read", async () => {
    const { service, logs } = harness([view()], () => DEAD, { parkResult: false })
    const [account] = await listed(service)
    expect(account?.status).toBe("active")
    expect(logs).toEqual([])
  })

  test("with no park wired, a dead login is reported and nothing moves", async () => {
    const { service } = harness([view()], () => DEAD, { park: false })
    const [account] = await listed(service)
    expect(account?.status).toBe("active")
    expect(account?.credential?.present).toBe(false)
  })
})

describe("a reader that fails", () => {
  test("yields credential: null, parks nothing, and warns once", async () => {
    const { service, parked, logs } = harness([view()], () => {
      throw new Error("EIO: input/output error")
    })
    const [account] = await listed(service)

    expect(account?.credential).toBeNull()
    expect(account?.status).toBe("active")
    expect(parked).toEqual([])
    expect(logs).toEqual(["warn claude credential metadata unreadable"])
  })

  test("does not poison the cache: the next read tries the disk again", async () => {
    let fail = true
    const { service, reads } = harness([view()], () => {
      if (fail) throw new Error("EIO")
      return LIVE
    })
    await listed(service)
    fail = false
    const [account] = await listed(service)
    expect(reads).toHaveLength(2)
    expect(account?.credential?.present).toBe(true)
  })
})

describe("what the view can never carry", () => {
  test("the serialized view holds no token-shaped string and no token key", async () => {
    // Even a reader that misbehaved and smuggled a token onto an extra field cannot reach the view:
    // the credential object is rebuilt from four named fields.
    const leaky = { ...LIVE, accessToken: FAKE_TOKEN } as CredentialMetadata
    const [account] = await listed(harness([view()], () => leaky).service)
    const serialized = JSON.stringify(account)

    expect(serialized).not.toContain(FAKE_TOKEN)
    expect(serialized).not.toContain("sk-ant-")
    expect(serialized).not.toContain('"accessToken"')
    expect(serialized).not.toContain('"refreshToken"')
    expect(Object.keys(account?.credential ?? {}).sort()).toEqual([
      "expiresAt",
      "present",
      "rateLimitTier",
      "subscriptionType",
    ])
  })
})

describe("createCredentialPark", () => {
  const row = (status: AccountRow["status"]): AccountRow =>
    ({ id: SUB_ID, provider: "anthropic-oauth", status }) as AccountRow

  test("writes active → needs_reauth conditionally, audits it, and refreshes the catalog", async () => {
    const writes: string[] = []
    const events: AuditEventInput[] = []
    let refreshed = 0
    const park = createCredentialPark({
      accounts: {
        updateStatusWhen: async (id, from, to) => {
          writes.push(`${id} ${from.join(",")} -> ${to}`)
          return row(to)
        },
      },
      audit: {
        record: async (event) => {
          events.push(event)
        },
      },
      refreshCatalog: async () => {
        refreshed += 1
      },
    })

    expect(await park(SUB_ID, NOW)).toBe(true)
    expect(writes).toEqual([`${SUB_ID} active -> needs_reauth`])
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("account.updated")
    expect(events[0]?.subjectId).toBe(SUB_ID)
    expect(events[0]?.detail).toMatchObject({
      status: "needs_reauth",
      previousStatus: "active",
      source: "credential_metadata",
    })
    expect(refreshed).toBe(1)
  })

  test("a row that was no longer active is not audited and reports false", async () => {
    const events: AuditEventInput[] = []
    const park = createCredentialPark({
      accounts: { updateStatusWhen: async () => undefined },
      audit: {
        record: async (event) => {
          events.push(event)
        },
      },
    })

    expect(await park(SUB_ID, NOW)).toBe(false)
    expect(events).toEqual([])
  })
})
