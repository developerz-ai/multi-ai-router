/**
 * How many `claude` subprocesses may run at once, globally and per Account.
 *
 * Every `query()` spawns a process running a ~200 MB native binary, so this is a memory bound, not
 * a connection pool: exceeding it does not slow the router down, it exhausts the container
 * (docs/idea/11-anthropic-agent-sdk.md#1-why-the-sdk-path). Excess callers **queue** rather than
 * fail — a subscription request that waited 400 ms is a served request, and a 503 is not.
 *
 * **Two gates, and the order between them is the design.** A caller takes its Account's slot first
 * and the global slot second. Reversed, an Account bursting past its own limit would sit on global
 * capacity while it waited, and every other Account in the Pool would starve behind it — which is
 * precisely the failure a per-Account limit exists to prevent (§9: "one Account's burst must not
 * starve the Pool"). Holding your own budget while you wait costs only yourself.
 *
 * There is no deadlock to worry about even so: both gates are counting semaphores acquired in one
 * fixed order, and every holder releases.
 *
 * FIFO within each gate, so a queued request cannot be overtaken indefinitely. In-memory and
 * therefore **per replica** — two replicas run up to twice the configured processes, which is the
 * honest reading of a per-container memory bound, and the same trade `services/dataplane/limits.ts`
 * documents for per-key rate limiting.
 */

export interface SdkConcurrencyLimits {
  /** Subprocesses in flight across every Account on this replica. */
  readonly global: number
  /** Subprocesses in flight for any one Account. Bounded above by `global` in practice. */
  readonly perAccount: number
}

export interface SdkSlot {
  /** Hands the permits back. Idempotent — a double release must not inflate capacity. */
  release(): void
}

export interface SdkConcurrency {
  /**
   * Waits for a slot for `accountId`, then holds it until the returned slot is released.
   *
   * @throws the signal's own abort reason when the caller goes away while queued — a `TimeoutError`
   * for an attempt deadline, an `AbortError` for a client disconnect, so `runSdkAttempt` classifies
   * the wait exactly as it classifies the call.
   */
  acquire(accountId: string, signal: AbortSignal): Promise<SdkSlot>
  /** Subprocess slots held across all Accounts. Observability and tests; nothing routes on it. */
  readonly inFlight: number
  /** Callers waiting on either gate. */
  readonly queued: number
  inFlightFor(accountId: string): number
}

export function createSdkConcurrency(limits: SdkConcurrencyLimits): SdkConcurrency {
  const global = createGate(limits.global)
  // One gate per Account, created on first use and dropped when it falls idle: an Account that is
  // deleted, or simply quiet, must not hold a map entry for the life of the process.
  const accounts = new Map<string, Gate>()

  const gateFor = (accountId: string): Gate => {
    const existing = accounts.get(accountId)
    if (existing !== undefined) return existing
    const created = createGate(limits.perAccount)
    accounts.set(accountId, created)
    return created
  }

  const forget = (accountId: string, gate: Gate): void => {
    if (gate.idle && accounts.get(accountId) === gate) accounts.delete(accountId)
  }

  return {
    acquire: async (accountId, signal) => {
      const account = gateFor(accountId)
      const releaseAccount = await account.acquire(signal)

      let releaseGlobal: () => void
      try {
        releaseGlobal = await global.acquire(signal)
      } catch (error) {
        // The Account permit is already ours; a caller that never gets a slot must not keep it.
        releaseAccount()
        forget(accountId, account)
        throw error
      }

      return {
        release: once(() => {
          releaseGlobal()
          releaseAccount()
          forget(accountId, account)
        }),
      }
    },

    get inFlight() {
      return global.held
    },

    get queued() {
      let waiting = global.waiting
      for (const gate of accounts.values()) waiting += gate.waiting
      return waiting
    },

    inFlightFor: (accountId) => accounts.get(accountId)?.held ?? 0,
  }
}

interface Gate {
  acquire(signal: AbortSignal): Promise<() => void>
  readonly held: number
  readonly waiting: number
  readonly idle: boolean
}

function createGate(limit: number): Gate {
  // Clamped rather than rejected: a misconfigured ceiling should throttle traffic, never stop it,
  // and a zero-permit semaphore would wedge every subscription request on this replica forever.
  const permits = Math.max(1, Math.floor(limit))
  let held = 0
  const queue: Array<() => void> = []

  const release = (): void => {
    const next = queue.shift()
    // The permit is handed straight to the next waiter instead of being returned and re-taken:
    // `held` never dips, so a fresh caller cannot slip past the queue in between.
    if (next === undefined) held -= 1
    else next()
  }

  return {
    acquire: async (signal) => {
      throwIfAborted(signal)
      if (held < permits) {
        held += 1
        return once(release)
      }

      await new Promise<void>((resolve, reject) => {
        const admit = (): void => {
          signal.removeEventListener("abort", onAbort)
          resolve()
        }
        const onAbort = (): void => {
          const at = queue.indexOf(admit)
          if (at >= 0) queue.splice(at, 1)
          reject(abortReason(signal))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        queue.push(admit)
      })

      return once(release)
    },

    get held() {
      return held
    },
    get waiting() {
      return queue.length
    },
    get idle() {
      return held === 0 && queue.length === 0
    },
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal)
}

/**
 * The reason the signal itself carries, so a deadline stays a `TimeoutError` and a disconnect stays
 * an `AbortError` all the way to `runSdkAttempt`'s classification. Only synthesized when a caller
 * aborted with a non-Error reason.
 */
function abortReason(signal: AbortSignal): unknown {
  if (signal.reason instanceof Error) return signal.reason
  const error = new Error("the Agent SDK slot was released before it was granted")
  error.name = "AbortError"
  return error
}

function once(action: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    action()
  }
}
