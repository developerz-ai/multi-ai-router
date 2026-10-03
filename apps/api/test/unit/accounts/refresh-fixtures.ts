import type { AccountRepository, AccountRow } from "@multi-ai-router/db"
import { createLogger } from "../../../src/logging/logger"
import {
  type CredentialRefresherDeps,
  createCredentialRefresher,
  writeStoredOAuth,
} from "../../../src/services/accounts"
import type { AuditEventInput } from "../../../src/services/admin"
import { createCredentialCipher } from "../../../src/services/crypto/cipher"
import { accountRow as durableAccountRow } from "../../support/account-row"

export const NOW = new Date("2026-07-25T09:00:00.000Z")
export const CIPHER = createCredentialCipher({ key: new Uint8Array(32).fill(3) })
export function tokenResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}
export function accountRow(overrides: Partial<AccountRow> = {}): AccountRow {
  return durableAccountRow({
    id: "acct-1",
    label: "acct-1",
    provider: "openai-oauth",
    status: "active",
    authMaterial: CIPHER.encrypt(
      writeStoredOAuth({
        accessToken: "old-access",
        refreshToken: "rt-1",
        providerAccountId: "identity-1",
      }),
    ),
    lifecycleVersion: 0,
    healthRecoveryVersion: 0,
    authRecoveryVersion: 0,
    authorizationAttemptId: null,
    configDir: null,
    tokenExpiresAt: new Date(NOW.getTime() + 3_600_000),
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  })
}
export function fakeAccounts(rows: AccountRow[]): CredentialRefresherDeps["accounts"] {
  return {
    list: async () => [...rows],
    findById: async (id) => rows.find((r) => r.id === id),
    saveRefreshedCredential: async (input) => {
      const index = rows.findIndex(
        (r) => r.id === input.id && r.authMaterial === input.expectedAuthMaterial,
      )
      const held = rows[index]
      if (held === undefined) return undefined
      const next = {
        ...held,
        authMaterial: input.authMaterial,
        tokenExpiresAt: input.tokenExpiresAt,
        updatedAt: input.now,
      }
      rows[index] = next
      return next
    },
    transitionObservedStatus: async (input) => {
      const index = rows.findIndex(
        (r) =>
          r.id === input.id &&
          r.authMaterial === input.expected.authMaterial &&
          r.lifecycleVersion === input.expected.lifecycleVersion &&
          r.status === input.expected.status,
      )
      const held = rows[index]
      if (held === undefined || held.status === input.status) return undefined
      const next = { ...held, status: input.status, updatedAt: input.now }
      rows[index] = next
      return next
    },
  } satisfies Pick<
    AccountRepository,
    "list" | "findById" | "saveRefreshedCredential" | "transitionObservedStatus"
  >
}
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
export function harness(
  rows: AccountRow[],
  config: Partial<CredentialRefresherDeps["config"]> = {},
  overrides: Partial<CredentialRefresherDeps> = {},
) {
  const clock = { now: NOW }
  const events: AuditEventInput[] = []
  const scheduled: { run: () => void; delay: number; cancelled: boolean }[] = []
  let behavior = async () =>
    tokenResponse({ access_token: "new-access", refresh_token: "rt-2", expires_in: 3_600 })
  let calls = 0
  let barriers = 0
  const deps: CredentialRefresherDeps = {
    accounts: fakeAccounts(rows),
    cipher: CIPHER,
    audit: { record: async (event) => void events.push(event) },
    fetch: async () => {
      calls++
      return behavior()
    },
    now: () => clock.now,
    logger: createLogger({ level: "error", write: () => undefined }),
    refreshLock: {
      tryRun: async (_id, signal, work) =>
        signal.aborted
          ? { acquired: false, reason: "aborted" }
          : { acquired: true, value: await work(signal) },
    },
    refreshCatalogAfterMutation: async () => {
      barriers++
    },
    config: { leadFraction: 0.75, minDelayMs: 1_000, maxAttempts: 2, timeoutMs: 5_000, ...config },
    schedule: (run, delay) => {
      const call = { run, delay, cancelled: false }
      scheduled.push(call)
      return () => {
        call.cancelled = true
      }
    },
    ...overrides,
  }
  return {
    refresher: createCredentialRefresher(deps),
    rows,
    deps,
    events,
    clock,
    scheduled,
    barriers: () => barriers,
    schedule: {
      count: () => scheduled.filter((s) => !s.cancelled).length,
      delays: () => scheduled.filter((s) => !s.cancelled).map((s) => s.delay),
      fireAll: () => {
        for (const s of [...scheduled])
          if (!s.cancelled) {
            s.cancelled = true
            s.run()
          }
      },
    },
    upstream: {
      calls: () => calls,
      respondWith: (next: () => Promise<Response>) => {
        behavior = next
      },
      pause: () => {
        const control = deferred<Response>()
        behavior = () => control.promise
        return control
      },
    },
  }
}
export async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await Promise.resolve()
  }
  throw new Error("expected asynchronous boundary was not reached")
}
