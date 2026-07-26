/**
 * Builders for the data-plane tests.
 *
 * Everything the data plane touches is injected — the cipher, the key repository, the account
 * catalog, the clock, and `fetch` itself — so nothing here needs a database, a network, or a live
 * provider. `bin/test` must never reach a real upstream.
 */

import { generateRouterKey, routerKeyDisplayPrefix } from "@multi-ai-router/core"
import type { ApiKeyRow } from "@multi-ai-router/db"
import { type CredentialCipher, createCredentialCipher } from "../../../src/services/crypto/cipher"
import {
  createHealthStore,
  type HealthStore,
  type RoutableAccount,
  type RoutingCatalog,
  routingView,
} from "../../../src/services/dataplane"
import type { AccountSnapshot, PoolSnapshot } from "../../../src/services/routing"
import type { UsageRecord } from "../../../src/services/usage"

export const NOW = new Date("2026-01-01T12:00:00.000Z")

/** A fixed 32-byte key. Test-only material; nothing here is a real credential. */
export function cipher(): CredentialCipher {
  return createCredentialCipher({ key: new Uint8Array(32).fill(7) })
}

export function apiKeyRow(
  value: string,
  cryptor: CredentialCipher,
  overrides: Partial<ApiKeyRow> = {},
): ApiKeyRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    name: "test-key",
    value: cryptor.encrypt(value),
    prefix: routerKeyDisplayPrefix(value) ?? value.slice(0, 17),
    scope: "all",
    rateLimitRequests: null,
    rateLimitWindowSeconds: null,
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

export function newRouterKey(): string {
  return generateRouterKey()
}

/** A repository whose only query is the indexed prefix lookup, counted so a test can assert it. */
export interface StubKeyRepository {
  findUsableByPrefix(prefix: string, now: Date): Promise<ApiKeyRow[]>
  readonly queries: number
  rows: ApiKeyRow[]
}

export function keyRepository(rows: ApiKeyRow[]): StubKeyRepository {
  let queries = 0
  const repo = {
    rows,
    findUsableByPrefix(prefix: string, now: Date): Promise<ApiKeyRow[]> {
      queries += 1
      return Promise.resolve(
        repo.rows.filter(
          (row) =>
            row.prefix === prefix &&
            !row.revoked &&
            (row.expiresAt === null || row.expiresAt.getTime() > now.getTime()),
        ),
      )
    },
    get queries() {
      return queries
    },
  }
  return repo
}

export interface AccountOptions {
  readonly provider?: RoutableAccount["driver"]["provider"]
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly dialect?: RoutableAccount["driver"]["dialect"]
  readonly modelAliases?: Record<string, string>
  readonly snapshot?: Partial<AccountSnapshot>
  readonly cipher?: CredentialCipher
  /** Claude subscription accounts only. A path, never a credential — nothing is written to it. */
  readonly configDir?: string
}

export function account(id: string, options: AccountOptions = {}): RoutableAccount {
  const provider = options.provider ?? "anthropic-api"
  const cryptor = options.cipher ?? cipher()
  return {
    id,
    snapshot: routingView({ id, label: id, provider }, options.snapshot),
    driver: {
      id,
      provider,
      baseUrl: options.baseUrl ?? "https://upstream.test",
      dialect: options.dialect ?? null,
      modelAliases: options.modelAliases ?? null,
    },
    authMaterial: cryptor.encrypt(options.apiKey ?? `sk-${id}`),
    configDir: options.configDir ?? null,
  }
}

/**
 * A Claude subscription account, as the catalog holds one: a config directory and **no credential
 * material at all** (`services/accounts/rules.ts` enforces the pairing). Written this way so a test
 * asserting the SDK path never decrypts anything is asserting it against the real shape.
 */
export function subscriptionAccount(
  id: string,
  options: Omit<AccountOptions, "provider" | "apiKey"> = {},
): RoutableAccount {
  return {
    ...account(id, { ...options, provider: "anthropic-oauth" }),
    authMaterial: null,
    configDir: options.configDir ?? `/data/accounts/${id}`,
  }
}

export function catalog(
  accounts: readonly RoutableAccount[],
  pools: readonly PoolSnapshot[] = [],
): RoutingCatalog {
  return { accounts: () => accounts, pools: () => pools }
}

export function health(): HealthStore {
  return createHealthStore()
}

/** A clock a test drives by hand: no waiting, no flake. */
export interface TestClock {
  readonly now: () => Date
  readonly elapsed: () => number
  advance(ms: number): void
}

export function clock(start: Date = NOW): TestClock {
  let offset = 0
  return {
    now: () => new Date(start.getTime() + offset),
    elapsed: () => offset,
    advance(ms) {
      offset += ms
    },
  }
}

/** Collects usage records instead of writing them. */
export function usageSink(): { record(record: UsageRecord): void; readonly rows: UsageRecord[] } {
  const rows: UsageRecord[] = []
  return { record: (record) => void rows.push(record), rows }
}

export interface UpstreamCall {
  readonly url: string
  readonly method: string
  readonly headers: Headers
  readonly body: string
  /** The signal this attempt's own fetch was sent with — timeout-bound, and abort-linked to the
   *  client's own signal. Lets a test prove a client's disconnect actually reaches the upstream
   *  call rather than orphaning it. */
  readonly signal: AbortSignal
}

/** A scripted upstream. Each entry answers one call, in order; the last one repeats. */
export function mockUpstream(responses: readonly (() => Response)[]): {
  fetch: (request: Request) => Promise<Response>
  readonly calls: UpstreamCall[]
} {
  const calls: UpstreamCall[] = []
  return {
    calls,
    async fetch(request) {
      const body = request.body === null ? "" : await request.clone().text()
      calls.push({
        url: request.url,
        method: request.method,
        headers: new Headers(request.headers),
        body,
        signal: request.signal,
      })
      const make = responses[Math.min(calls.length - 1, responses.length - 1)]
      if (make === undefined) throw new Error("mockUpstream: no response scripted")
      return make()
    },
  }
}

export function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  })
}

/**
 * A response whose body arrives in pieces, with a gate a test opens chunk by chunk. `abort` breaks
 * the stream after bytes are already on the wire — the case where failover must be over.
 */
export function slowStream(chunks: readonly string[]): {
  response: Response
  release(index: number): void
  finish(): void
  abort(): void
} {
  const gates = chunks.map(() => {
    let open: () => void = () => undefined
    const promise = new Promise<void>((resolve) => {
      open = resolve
    })
    return { promise, open }
  })
  let finish: () => void = () => undefined
  let broke = false
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })

  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const [index, chunk] of chunks.entries()) {
        await gates[index]?.promise
        controller.enqueue(encoder.encode(chunk))
      }
      await done
      if (broke) controller.error(new Error("upstream stream broke mid-response"))
      else controller.close()
    },
  })

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    release: (index) => gates[index]?.open(),
    finish: () => finish(),
    abort: () => {
      broke = true
      finish()
    },
  }
}
