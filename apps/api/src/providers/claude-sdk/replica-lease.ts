import { randomUUID } from "node:crypto"
import type { AccountReplicaLeaseRepository, ReplicaLeaseToken } from "@multi-ai-router/db"
import { UpstreamAdmissionRefused } from "../upstream-admission"

export interface ReplicaGenerationHandle extends ReplicaLeaseToken {
  readonly signal: AbortSignal
  valid(): boolean
  assert(): void
  remainingMs(): number
}
export interface ReplicaLeaseConfig {
  ttlMs: number
  heartbeatMs: number
  safetyMarginMs?: number
  batchSize: number
}
interface Entry {
  handle: ReplicaGenerationHandle
  abort: AbortController
  deadline: number
  ready: boolean
  draining: boolean
}
export interface ReplicaAttachment {
  identity: string
  // Resolves only after external exclusive attachment and local guardian retirement.
  attach(token: ReplicaLeaseToken, previousIdentity: string | null): Promise<void>
  provisionNew?(token: ReplicaLeaseToken): Promise<void>
}

export function createReplicaLeaseManager(
  repository: AccountReplicaLeaseRepository,
  storage: ReplicaAttachment,
  config: ReplicaLeaseConfig,
  clock: () => number = () => performance.now(),
) {
  const safetyMarginMs = config.safetyMarginMs ?? 0
  if (
    !Number.isInteger(config.ttlMs) ||
    config.ttlMs < 100 ||
    config.ttlMs > 300_000 ||
    !Number.isInteger(config.heartbeatMs) ||
    config.heartbeatMs < 1 ||
    !Number.isInteger(safetyMarginMs) ||
    safetyMarginMs < 0 ||
    config.heartbeatMs * 3 + safetyMarginMs >= config.ttlMs ||
    !Number.isInteger(config.batchSize) ||
    config.batchSize < 1 ||
    config.batchSize > 1024
  )
    throw new RangeError("invalid replica lease policy")
  const owner = randomUUID()
  const entries = new Map<string, Entry>()
  const pending = new Map<string, Promise<ReplicaGenerationHandle | undefined>>()
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let renewing: Promise<void> | undefined
  let lastClock = clock()
  let clockFailed = !Number.isFinite(lastClock)
  let cursor = 0
  const now = () => {
    const value = clock()
    if (clockFailed || !Number.isFinite(value) || value < lastClock) {
      clockFailed = true
      for (const entry of entries.values()) entry.abort.abort()
      return Number.POSITIVE_INFINITY
    }
    lastClock = value
    return value
  }
  const valid = (entry: Entry) => {
    if (now() >= entry.deadline) entry.abort.abort()
    return !entry.abort.signal.aborted
  }
  async function acquire(
    id: string,
    provision = false,
  ): Promise<ReplicaGenerationHandle | undefined> {
    if (closed) return undefined
    const existing = entries.get(id)
    if (existing) {
      if (existing.ready && !existing.draining && valid(existing)) return existing.handle
      if (existing.draining || valid(existing)) return undefined
      // Retained handles stay aborted. Storage must independently drain and fence their writers.
      entries.delete(id)
    }
    const started = now()
    if (!Number.isFinite(started)) return undefined
    const row = await repository.acquire(id, owner, config.ttlMs)
    if (!row) return undefined
    const abort = new AbortController()
    const token = { accountId: id, owner, generation: row.generation }
    const handle: ReplicaGenerationHandle = {
      ...token,
      signal: abort.signal,
      valid: () => entry.ready && !entry.draining && valid(entry),
      assert() {
        if (!handle.valid())
          throw new UpstreamAdmissionRefused("account replica ownership unavailable")
      },
      remainingMs: () => (valid(entry) ? Math.max(0, entry.deadline - now()) : 0),
    }
    const entry: Entry = {
      handle,
      abort,
      deadline: started + config.ttlMs - safetyMarginMs,
      ready: false,
      draining: false,
    }
    entries.set(id, entry)
    if (closed || !valid(entry)) {
      abort.abort()
      return undefined
    }
    try {
      if (provision && row.storageIdentity === null) {
        if (!storage.provisionNew) throw new Error("new account storage authority unavailable")
        await storage.provisionNew(token)
      } else await storage.attach(token, row.storageIdentity)
      if (closed || !valid(entry)) {
        abort.abort()
        return undefined
      }
      if (!(await repository.ready(token, storage.identity)) || closed || !valid(entry)) {
        abort.abort()
        return undefined
      }
      entry.ready = true
      return handle
    } catch {
      abort.abort()
      return undefined
    }
  }
  const ensure = (id: string, provision = false) => {
    const running = pending.get(id)
    if (running) return running
    const result = acquire(id, provision)
      .catch(() => undefined)
      .finally(() => pending.delete(id))
    pending.set(id, result)
    return result
  }
  async function heartbeat() {
    for (const entry of entries.values()) {
      if (!valid(entry)) continue
      const started = now()
      try {
        const accepted = await repository.heartbeat(entry.handle, config.ttlMs)
        // Never resurrect authority if the old deadline elapsed during the round trip.
        if (!accepted || !valid(entry)) entry.abort.abort()
        else entry.deadline = started + config.ttlMs - safetyMarginMs
      } catch {
        entry.abort.abort()
      }
    }
  }
  const renew = () => {
    if (renewing) return renewing
    renewing = heartbeat().finally(() => {
      renewing = undefined
    })
    return renewing
  }
  const schedule = () => {
    timer = setTimeout(() => {
      void renew().finally(() => {
        if (timer !== undefined) schedule()
      })
    }, config.heartbeatMs)
  }
  return {
    owner,
    ensure,
    renew,
    eligible: (id: string) => entries.get(id)?.handle.valid() ?? false,
    handle(id: string) {
      const handle = entries.get(id)?.handle
      if (!handle?.valid())
        throw new UpstreamAdmissionRefused("account replica ownership unavailable")
      return handle
    },
    async reconcile(ids: readonly string[]) {
      if (!ids.length) return
      if (cursor >= ids.length) cursor = 0
      const selected = ids.slice(cursor, cursor + config.batchSize)
      cursor += selected.length
      for (const id of selected) await ensure(id)
    },
    start() {
      if (timer === undefined && !closed) schedule()
    },
    closeAdmission() {
      closed = true
      for (const entry of entries.values()) entry.draining = true
    },
    async stop(quiesce: () => Promise<void>) {
      closed = true
      for (const entry of entries.values()) entry.draining = true
      // Renewals remain active until all pending attachment and operation scopes have retired.
      try {
        await Promise.all(pending.values())
        await quiesce()
        await renewing
        for (const entry of entries.values()) {
          if (valid(entry) && (await repository.drain(entry.handle)))
            await repository.release(entry.handle)
        }
      } finally {
        clearTimeout(timer)
        timer = undefined
        for (const entry of entries.values()) entry.abort.abort()
      }
    },
  }
}
export type ReplicaLeaseManager = ReturnType<typeof createReplicaLeaseManager>
