import { describe, expect, test } from "bun:test"
import type {
  ClaudeCliLogin,
  ClaudeLoginHandle,
  CredentialGuard,
  CredentialState,
} from "../../../src/providers/claude-sdk/login"
import { ClaudeLoginError } from "../../../src/providers/claude-sdk/login"
import {
  type ClaudeConnectService,
  createAccountsService,
  createClaudeConnectService,
} from "../../../src/services/accounts"
import { withAvailability } from "../../../src/services/accounts/availability"
import type { AccountsService } from "../../../src/services/accounts/service"
import { createAuditRecorder } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import {
  createHealthStore,
  type HealthStore,
  type RoutableAccount,
} from "../../../src/services/dataplane"
import { createMemoryConfigDirs, type MemoryConfigDirs } from "../../support/config-dirs"
import { createMemoryStore, type MemoryStore } from "../../support/memory-store"

/**
 * Connecting a Claude subscription, with a fake `claude` CLI.
 *
 * The login itself is stubbed at the `ClaudeCliLogin` seam, so no binary runs and no OAuth endpoint
 * is reached (CLAUDE.md testing rules). What is real is everything the router owns: the one-shot
 * `state`, the TTL, the binding to a row, and the rule that no code, state, or token appears in a
 * result or an audit row.
 */

const NOW = new Date("2026-07-25T09:00:00.000Z")
const STATE = "s-9f2c1"
const URL = `https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a&state=${STATE}`
const PASTE = `ac_notarealcode#${STATE}`

interface FakeLogin extends ClaudeCliLogin {
  readonly handles: FakeHandle[]
  /** Entries into `start`, returned or not — what a per-account queue has to hold at one. */
  readonly calls: { starts: number }
  /** Makes the next `start` throw this instead of returning a handle. */
  refuse(error: ClaudeLoginError): void
  /** Makes the next `submit` throw this instead of succeeding. */
  reject(error: ClaudeLoginError): void
  /** Parks every `start` before it yields a handle, the way a real CLI blocks on its handshake. */
  park(): void
  /** Lets the parked starts through, and stops parking new ones. */
  release(): void
}

interface FakeHandle extends ClaudeLoginHandle {
  readonly submitted: string[]
  readonly stats: { cancels: number }
}

function fakeLogin(state = STATE, url = URL): FakeLogin {
  const handles: FakeHandle[] = []
  const calls = { starts: 0 }
  let refusal: ClaudeLoginError | null = null
  let rejection: ClaudeLoginError | null = null
  let parked: { promise: Promise<void>; open: () => void } | null = null

  return {
    handles,
    calls,
    refuse: (error) => {
      refusal = error
    },
    reject: (error) => {
      rejection = error
    },
    park: () => {
      let open = (): void => undefined
      const promise = new Promise<void>((resolve) => {
        open = resolve
      })
      parked = { promise, open }
    },
    release: () => {
      const held = parked
      parked = null
      held?.open()
    },
    start: async () => {
      calls.starts += 1
      if (parked !== null) await parked.promise
      if (refusal !== null) {
        const thrown = refusal
        refusal = null
        throw thrown
      }
      const submitted: string[] = []
      const stats = { cancels: 0 }
      const handle: FakeHandle = {
        authorizeUrl: url,
        state,
        submitted,
        stats,
        submit: async (value) => {
          submitted.push(value)
          if (rejection !== null) {
            const thrown = rejection
            rejection = null
            throw thrown
          }
        },
        cancel: () => {
          stats.cancels += 1
        },
      }
      handles.push(handle)
      return handle
    },
  }
}

function fakeCredentials(state: CredentialState = "compact"): CredentialGuard {
  return { settle: async () => state }
}

interface Harness {
  readonly connect: ClaudeConnectService
  readonly login: FakeLogin
  readonly store: MemoryStore
  readonly configDirs: MemoryConfigDirs
  readonly clock: { now: Date }
  readonly health: HealthStore
  /** How many times a completed login asked for the warm catalog to be re-read. */
  readonly catalogRefreshes: { count: number }
  /** The admin read exactly as the console sees it: the live health verdict overlaid on the row. */
  readonly read: AccountsService
  account(provider?: "anthropic-oauth" | "openrouter"): Promise<string>
}

function harness(
  options: { login?: FakeLogin; credentials?: CredentialGuard; ttlMinutes?: number } = {},
): Harness {
  const health = createHealthStore()
  const catalogRefreshes = { count: 0 }
  const store = createMemoryStore()
  const configDirs = createMemoryConfigDirs()
  const clock = { now: NOW }
  const login = options.login ?? fakeLogin()
  const audit = createAuditRecorder(store.audit)

  const accounts = createAccountsService({
    accounts: store.accounts,
    keys: store.keys,
    cipher: createCredentialCipher({ key: new Uint8Array(32).fill(7) }),
    configDirs: configDirs.dirs,
    audit,
    now: () => clock.now,
  })

  const connect = createClaudeConnectService({
    accounts: store.accounts,
    configDirs: configDirs.dirs,
    login,
    credentials: options.credentials ?? fakeCredentials(),
    audit,
    pendingLoginMinutes: options.ttlMinutes ?? 10,
    now: () => clock.now,
    health,
    refreshCatalog: async () => {
      catalogRefreshes.count += 1
    },
  })

  // The routing catalog the overlay consults, read live from the same rows the connect flow writes.
  const routable = async (): Promise<readonly RoutableAccount[]> =>
    (await store.accounts.list({})).map((row) => ({
      id: row.id,
      snapshot: {
        id: row.id,
        label: row.label,
        provider: row.provider,
        status: row.status,
        weight: row.weight,
        priority: row.priority,
        health: { consecutiveFailures: 0, inFlight: 0, recentTokens: 0 },
      },
      driver: {
        id: row.id,
        provider: row.provider,
        baseUrl: row.baseUrl,
        dialect: row.dialect ?? null,
        modelAliases: row.modelAliases,
      },
      authMaterial: null,
      configDir: row.configDir,
    }))
  let catalogAccounts: readonly RoutableAccount[] = []
  const read: AccountsService = {
    ...accounts,
    // `withAvailability` reads the catalog synchronously, so refresh it before each read.
    list: async (query) => {
      catalogAccounts = await routable()
      return decorated.list(query)
    },
    get: async (id) => {
      catalogAccounts = await routable()
      return decorated.get(id)
    },
  }
  const decorated = withAvailability(accounts, {
    catalog: { accounts: () => catalogAccounts, pools: () => [] },
    health,
    recheck: { lastCheckedAt: () => null },
    now: () => clock.now,
  })

  return {
    connect,
    login,
    store,
    configDirs,
    clock,
    health,
    catalogRefreshes,
    read,
    account: async (provider = "anthropic-oauth") => {
      const created = await accounts.create({
        label: `${provider}-1`,
        provider,
        ...(provider === "openrouter" ? { credential: "sk-not-a-real-key" } : {}),
      })
      if (!created.ok) throw new Error(`create failed: ${created.failure.message}`)
      return created.value.id
    },
  }
}

/** One macrotask, so every continuation an unawaited call has queued has run. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function failure(result: { ok: boolean } & Record<string, unknown>) {
  if (result.ok) throw new Error("expected a failure")
  const { failure: reason } = result as { failure: { code: string; message: string } }
  return reason
}

describe("starting a login", () => {
  test("provisions the config directory and hands back the CLI's own URL", async () => {
    const h = harness()
    const id = await h.account()

    const started = await h.connect.begin(id, "connect")
    if (!started.ok) throw new Error(started.failure.message)

    expect(started.value.authorizeUrl).toBe(URL)
    expect(started.value.capture).toBe("paste")
    expect(started.value.expiresAt).toBe("2026-07-25T09:10:00.000Z")
    expect(h.configDirs.present.has(`/data/claude/${id}`)).toBe(true)
  })

  test("the window comes from config, not a constant", async () => {
    const h = harness({ ttlMinutes: 2 })
    const started = await h.connect.begin(await h.account(), "connect")
    if (!started.ok) throw new Error(started.failure.message)

    expect(started.value.expiresAt).toBe("2026-07-25T09:02:00.000Z")
  })

  test("refuses an account that is not a Claude subscription", async () => {
    const h = harness()
    const reason = failure(await h.connect.begin(await h.account("openrouter"), "connect"))

    expect(reason.code).toBe("not_a_subscription_account")
  })

  test("refuses an id no account has", async () => {
    const h = harness()
    const reason = failure(await h.connect.begin("00000000-0000-4000-8000-000000000000", "connect"))

    expect(reason.code).toBe("not_found")
  })

  test("a second begin supersedes the first, leaving one live login", async () => {
    const h = harness()
    const id = await h.account()

    await h.connect.begin(id, "connect")
    await h.connect.begin(id, "connect")

    expect(h.login.handles).toHaveLength(2)
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
    expect(h.login.handles[1]?.stats.cancels).toBe(0)
  })

  test("a CLI that will not start is reported by name", async () => {
    const login = fakeLogin()
    login.refuse(new ClaudeLoginError("cli_unavailable", "the claude CLI could not be started"))
    const h = harness({ login })

    const reason = failure(await h.connect.begin(await h.account(), "connect"))
    expect(reason.code).toBe("claude_login_cli_unavailable")
  })

  test("an authorize URL with no state never becomes a pending login", async () => {
    const login = fakeLogin()
    login.refuse(new ClaudeLoginError("unbound_state", "the authorization URL carried no state"))
    const h = harness({ login })
    const id = await h.account()

    expect(failure(await h.connect.begin(id, "connect")).code).toBe("claude_login_unbound_state")
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })
})

describe("pasting the code back", () => {
  test("hands the whole value to the CLI and reports the account connected", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    const done = await h.connect.complete(id, `  ${PASTE}\n`)
    if (!done.ok) throw new Error(done.failure.message)

    expect(done.value).toEqual({ accountId: id, mode: "connect", connected: true, repaired: false })
    expect(h.login.handles[0]?.submitted).toEqual([PASTE])
  })

  test("a reconnect is the same call, audited as a repair rather than a first login", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "reconnect")

    const done = await h.connect.complete(id, PASTE)
    if (!done.ok) throw new Error(done.failure.message)

    expect(done.value.mode).toBe("reconnect")
    // Same row, same directory: nothing about a reconnect creates or replaces anything.
    expect(h.configDirs.present.has(`/data/claude/${id}`)).toBe(true)
    expect(h.store.rows.audit.at(-1)?.kind).toBe("account.reauthorized")
  })

  test("says so when the credential file had to be re-minified", async () => {
    const h = harness({ credentials: fakeCredentials("repaired") })
    const id = await h.account()
    await h.connect.begin(id, "connect")

    const done = await h.connect.complete(id, PASTE)
    if (!done.ok) throw new Error(done.failure.message)
    expect(done.value.repaired).toBe(true)
  })

  test("a login that left no credential is a failure, not a connected account", async () => {
    const h = harness({ credentials: fakeCredentials("absent") })
    const id = await h.account()
    await h.connect.begin(id, "connect")

    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_credential")
  })

  test("an unparseable credential file is refused the same way", async () => {
    const h = harness({ credentials: fakeCredentials("unreadable") })
    const id = await h.account()
    await h.connect.begin(id, "connect")

    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_credential")
  })

  test("clears needs_reauth, and nothing else", async () => {
    const h = harness()
    const id = await h.account()
    await h.store.accounts.update(id, { status: "needs_reauth" }, NOW)
    await h.connect.begin(id, "connect")

    await h.connect.complete(id, PASTE)
    expect((await h.store.accounts.findById(id))?.status).toBe("active")
  })

  test("a login lifts the request path's verdict too — the admin read says active without a re-check", async () => {
    // The production shape (#reconnect): the data plane classified an `auth` failure and parked the
    // account twice — the row, and the breaker's `blocked` phase in this process. Clearing only the
    // row left the console overlay reading `needs_reauth` until an operator pressed Re-check.
    const h = harness()
    const id = await h.account()
    h.health.recordFailure(id, { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })
    await h.store.accounts.update(id, { status: "needs_reauth" }, NOW)

    const parked = await h.read.get(id)
    if (!parked.ok) throw new Error(parked.failure.message)
    expect(parked.value.status).toBe("needs_reauth")

    await h.connect.begin(id, "reconnect")
    const completed = await h.connect.complete(id, PASTE)
    expect(completed.ok).toBe(true)

    const restored = await h.read.get(id)
    if (!restored.ok) throw new Error(restored.failure.message)
    expect(restored.value.status).toBe("active")
    expect(restored.value.availability?.configuredStatus).toBe("active")
    expect(h.health.stateOf(id).breaker.status).toBe("active")
    // Once, and awaited: the console re-reads the list the instant `complete` answers.
    expect(h.catalogRefreshes.count).toBe(1)
  })

  test("a login on an account whose row already said active still clears a stale live verdict", async () => {
    const h = harness()
    const id = await h.account()
    h.health.recordFailure(id, { kind: "auth", message: "401" }, NOW, { authKind: "oauth" })

    await h.connect.begin(id, "reconnect")
    await h.connect.complete(id, PASTE)

    expect(h.health.stateOf(id).breaker.status).toBe("active")
    // The row did not change, so there was nothing for the catalog to re-read.
    expect(h.catalogRefreshes.count).toBe(0)
  })

  test("a completed login spends no turn: the CLI's own login is the only subprocess", async () => {
    // The operator's rule — checking on a subscription must never cost usage — read at the seam
    // that could break it: the connect service holds no probe, no test, and no `query()`; the one
    // CLI it starts is the login itself, and one paste goes to it.
    const h = harness()
    const id = await h.account()

    await h.connect.begin(id, "connect")
    await h.connect.complete(id, PASTE)

    expect(h.login.calls.starts).toBe(1)
    expect(h.login.handles[0]?.submitted).toEqual([PASTE])
    expect(h.health.stateOf(id).inFlight).toBe(0)
  })

  test("a disabled account stays disabled — connecting is not a way to re-enable it", async () => {
    const h = harness()
    const id = await h.account()
    await h.store.accounts.update(id, { status: "disabled" }, NOW)
    await h.connect.begin(id, "connect")

    await h.connect.complete(id, PASTE)
    expect((await h.store.accounts.findById(id))?.status).toBe("disabled")
  })

  test("a CLI that rejected the code is reported by name", async () => {
    const login = fakeLogin()
    login.reject(new ClaudeLoginError("login_rejected", "the claude CLI did not accept that code"))
    const h = harness({ login })
    const id = await h.account()
    await h.connect.begin(id, "connect")

    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("claude_login_login_rejected")
  })
})

describe("the checks the router owns", () => {
  test("a state from another login is refused", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    const reason = failure(await h.connect.complete(id, "ac_notarealcode#s-someone-else"))
    expect(reason.code).toBe("state_mismatch")
    expect(h.login.handles[0]?.submitted).toEqual([])
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
  })

  test("a state is one-shot: a wrong paste burns the login rather than allowing a retry", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    expect(failure(await h.connect.complete(id, "ac_x#wrong")).code).toBe("state_mismatch")
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })

  test("a completed login cannot be replayed", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    expect((await h.connect.complete(id, PASTE)).ok).toBe(true)
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })

  test("a paste after the window closes is refused and the subprocess terminated", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    h.clock.now = new Date(NOW.getTime() + 11 * 60_000)
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("login_expired")
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
    expect(h.login.handles[0]?.submitted).toEqual([])
  })

  test("a malformed paste never reaches the CLI", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    const reason = failure(await h.connect.complete(id, "ac_notarealcode"))
    expect(reason.code).toBe("malformed_paste")
    expect(reason.message).not.toContain("ac_notarealcode")
    expect(h.login.handles[0]?.submitted).toEqual([])
  })

  test("one account's login cannot be completed against another's", async () => {
    const h = harness()
    const first = await h.account()
    const second = await h.account()
    await h.connect.begin(first, "connect")

    expect(failure(await h.connect.complete(second, PASTE)).code).toBe("no_pending_login")
    expect((await h.connect.complete(first, PASTE)).ok).toBe(true)
  })

  test("two accounts connect into two distinct config directories", async () => {
    const h = harness()
    const first = await h.account()
    const second = await h.account()

    await h.connect.begin(first, "connect")
    await h.connect.begin(second, "connect")

    expect(h.configDirs.present.has(`/data/claude/${first}`)).toBe(true)
    expect(h.configDirs.present.has(`/data/claude/${second}`)).toBe(true)
    expect(first).not.toBe(second)
  })

  test("cancelling releases the login, and cancelling nothing is not an error", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")

    const first = await h.connect.cancel(id)
    const second = await h.connect.cancel(id)
    if (!first.ok || !second.ok) throw new Error("cancel failed")

    expect(first.value.cancelled).toBe(true)
    expect(second.value.cancelled).toBe(false)
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
  })

  test("shutdown leaves no subprocess behind", async () => {
    const h = harness()
    await h.connect.begin(await h.account(), "connect")
    await h.connect.begin(await h.account(), "connect")

    h.connect.stop()
    expect(h.login.handles.map((handle) => handle.stats.cancels)).toEqual([1, 1])
  })
})

/**
 * Two admin calls for one account, overlapping — the operator who double-clicks Connect, or who
 * cancels while the CLI is still printing its URL. Every call here reads this account's one pending
 * login and then replaces it, so the awaits in between are where a second caller used to slip past.
 */
describe("two calls at once for one account", () => {
  test("the second begin waits for the first, so no subprocess is left unheld", async () => {
    const h = harness()
    const id = await h.account()

    h.login.park()
    const first = h.connect.begin(id, "connect")
    const second = h.connect.begin(id, "connect")
    await tick()

    // Unqueued, both callers would be inside the CLI right here — and only one of the two handles
    // about to exist would ever be reachable again.
    expect(h.login.calls.starts).toBe(1)

    h.login.release()
    const [a, b] = await Promise.all([first, second])
    if (!a.ok || !b.ok) throw new Error("both begins should have started a login")

    expect(h.login.handles).toHaveLength(2)
    // Superseded, so terminated — and because that is one code path with clearing its expiry timer,
    // the displaced login's TTL can no longer fire against the live one that replaced it.
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
    expect(h.login.handles[1]?.stats.cancels).toBe(0)
  })

  test("the paste reaches the login that superseded, never the one it displaced", async () => {
    const h = harness()
    const id = await h.account()

    h.login.park()
    const first = h.connect.begin(id, "connect")
    const second = h.connect.begin(id, "connect")
    h.login.release()
    await Promise.all([first, second])

    expect((await h.connect.complete(id, PASTE)).ok).toBe(true)
    expect(h.login.handles[0]?.submitted).toEqual([])
    expect(h.login.handles[1]?.submitted).toEqual([PASTE])
    // One pending login, so one completion: the displaced one is not a second chance.
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })

  test("a cancel that lands while the CLI is still starting cancels that login", async () => {
    const h = harness()
    const id = await h.account()

    h.login.park()
    const started = h.connect.begin(id, "connect")
    const cancelled = h.connect.cancel(id)
    await tick()
    h.login.release()

    expect((await started).ok).toBe(true)
    const result = await cancelled
    if (!result.ok) throw new Error(result.failure.message)

    // Answering "nothing was pending" and then letting the subprocess register anyway would leave
    // the operator with a login they had already called off.
    expect(result.value.cancelled).toBe(true)
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })

  test("a paste that lands while the CLI is still starting waits for it", async () => {
    const h = harness()
    const id = await h.account()

    h.login.park()
    const started = h.connect.begin(id, "connect")
    const done = h.connect.complete(id, PASTE)
    await tick()
    h.login.release()

    expect((await started).ok).toBe(true)
    expect((await done).ok).toBe(true)
  })

  test("two accounts start their logins at once — the queue is per account", async () => {
    const h = harness()
    const first = await h.account()
    const second = await h.account()

    h.login.park()
    const a = h.connect.begin(first, "connect")
    const b = h.connect.begin(second, "connect")
    await tick()

    // Five Claude subscriptions side by side is the normal case: one operator's handshake may not
    // make the other four wait.
    expect(h.login.calls.starts).toBe(2)

    h.login.release()
    const [x, y] = await Promise.all([a, b])
    expect([x.ok, y.ok]).toEqual([true, true])
    expect(h.login.handles.map((handle) => handle.stats.cancels)).toEqual([0, 0])
  })

  test("a login that started while the router was shutting down is terminated, not registered", async () => {
    const h = harness()
    const id = await h.account()

    h.login.park()
    const started = h.connect.begin(id, "connect")
    await tick()
    // `stop()` cannot reach a CLI that has not handed back a handle yet, so the login has to refuse
    // itself — otherwise this subprocess outlives the router.
    h.connect.stop()
    h.login.release()

    expect(failure(await started).code).toBe("shutting_down")
    expect(h.login.handles[0]?.stats.cancels).toBe(1)
    expect(failure(await h.connect.complete(id, PASTE)).code).toBe("no_pending_login")
  })
})

describe("what a connect is allowed to leave behind", () => {
  /** CLAUDE.md non-negotiable 1 and 3, and docs/idea/07-security.md#oauth-flow-safety. */
  test("no code, state, or token reaches an audit row", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")
    await h.connect.complete(id, PASTE)

    const connected = h.store.rows.audit.filter((row) => row.kind === "account.connected")
    expect(connected).toHaveLength(1)

    const serialized = JSON.stringify(h.store.rows.audit)
    expect(serialized).not.toContain("ac_notarealcode")
    expect(serialized).not.toContain(STATE)
  })

  test("no code or state is echoed in any result", async () => {
    const h = harness()
    const id = await h.account()

    const started = await h.connect.begin(id, "connect")
    const done = await h.connect.complete(id, PASTE)
    const rendered = JSON.stringify([started, done])

    expect(rendered).not.toContain("ac_notarealcode")
    // The URL is the one place a state may appear: the operator has to open it.
    expect(JSON.stringify(done)).not.toContain(STATE)
  })

  test("the account row never gains a credential from a subscription login", async () => {
    const h = harness()
    const id = await h.account()
    await h.connect.begin(id, "connect")
    await h.connect.complete(id, PASTE)

    const row = await h.store.accounts.findById(id)
    expect(row?.authMaterial).toBeNull()
    expect(row?.configDir).toBe(`/data/claude/${id}`)
  })
})
