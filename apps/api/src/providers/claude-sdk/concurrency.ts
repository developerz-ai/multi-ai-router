import { abortReason, throwIfAborted } from "./abort"
import {
  REAL_GATE_TIMER,
  type SdkGateClocks,
  type SdkGateHalf,
  type SdkGateTimer,
  SdkGateWaitExpiredError,
  type SdkWaitBudget,
} from "./gate-wait"
import { createWaiterQueue } from "./waiter-queue"

/**
 * How many Claude subscription turns may run at once, globally and per Account.
 *
 * Every Agent-SDK `query()` spawns a process running a ~200 MB native binary, and a warm fast-mode
 * HTTP turn takes a slot of the same gate without one, so this is a memory bound, not a
 * connection pool: exceeding it does not slow the router down, it exhausts the container
 * (docs/idea/11-anthropic-agent-sdk.md#1-why-the-sdk-path). Excess callers **queue**, but only up
 * to `CLAUDE_SDK_QUEUE_WAIT_MS` per request; an account-gate expiry then tries the next account
 * and a global-gate expiry skips the remaining Claude accounts (`gate-wait.ts`): a request
 * that waited 400 ms is a served request, while one that waits out its whole attempt deadline is a
 * client-side timeout nobody can read. A caller that passes no budget (the probes, the credential
 * keepalive) keeps the unbounded queue.
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
 *
 * **What this gate does not serialize: the `CLAUDE_CONFIG_DIR` itself — and something else now
 * does.** Up to `perAccount` subprocesses share one credential directory, each capable of an OAuth
 * refresh inside it. This module used to record that as an accepted risk, reasoning that "a refresh
 * lost to a concurrent rotation fails one request into the ordinary auth classification rather than
 * corrupting the file". **That reasoning was wrong, and production proved it on 2026-09-06**: the
 * refresh token rotates on use, so the loser of the race presents a spent token, and the CLI reads
 * the rejection as a dead login and blanks `.credentials.json`. Three of six Accounts were
 * deauthenticated in nine hours, every one of them with a month left on `refreshTokenExpiresAt`.
 *
 * The mitigation named here for that evidence — an exclusive drain of the per-Account gate, never a
 * quiet cut to `perAccount` — is now `credential-freshness.ts`, deliberately built *beside* this
 * gate rather than inside it: `claude auth status` and the login CLI spawn against the same
 * directory with a raw `Bun.spawn` and hold no slot, so a guard living in here would not cover them.
 * Callers take the freshness gate **first** and this one second, one fixed order, no deadlock.
 *
 * So `perAccount` remains what it always was — a memory bound, and throughput the pool is sized on.
 * It is not, and never was, the thing keeping a credential safe.
 */

/** The sentence an abort with a non-Error reason carries out of the queue (`abort.ts`). */
const NOT_GRANTED = "the Agent SDK slot was released before it was granted"

export interface SdkConcurrencyLimits {
  /** Claude turns in flight across every Account on this replica. */
  readonly global: number
  /** Claude turns in flight for any one Account. Bounded above by `global` in practice. */
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
   * With a `budget`, the wait is bounded by what the request has left: a free slot is taken at
   * once and a full gate refuses at once when nothing is left. Without one the queue is unbounded.
   *
   * @throws the signal's own abort reason when the caller goes away while queued — a `TimeoutError`
   * for an attempt deadline, an `AbortError` for a client disconnect, so `runSdkAttempt` classifies
   * the wait exactly as it classifies the call.
   * @throws {SdkGateWaitExpiredError} when a budgeted caller ran out of wait, naming the half it was
   * still queued on.
   */
  acquire(accountId: string, signal: AbortSignal, budget?: SdkWaitBudget): Promise<SdkSlot>
  /** Claude turn slots held across all Accounts. Observability and tests; nothing routes on it. */
  readonly inFlight: number
  /** Callers waiting on either gate. */
  readonly queued: number
  inFlightFor(accountId: string): number
}

export function createSdkConcurrency(
  limits: SdkConcurrencyLimits,
  clocks: SdkGateClocks = {},
): SdkConcurrency {
  const measure = {
    now: clocks.now ?? (() => performance.now()),
    timer: clocks.timer ?? REAL_GATE_TIMER,
  }
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
    acquire: async (accountId, signal, budget) => {
      const account = gateFor(accountId)
      let releaseAccount: () => void
      try {
        releaseAccount = await account.acquire(signal, waitOn(budget, "account", measure))
      } catch (error) {
        // A refused or expired caller may have created the gate: do not keep an idle entry.
        forget(accountId, account)
        throw error
      }

      let releaseGlobal: () => void
      try {
        releaseGlobal = await global.acquire(signal, waitOn(budget, "global", measure))
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

/** What a budgeted acquire waits with on one gate. Absent: the unbounded queue. */
interface GateWait {
  readonly budget: SdkWaitBudget
  readonly half: SdkGateHalf
  readonly now: () => number
  readonly timer: SdkGateTimer
}

function waitOn(
  budget: SdkWaitBudget | undefined,
  half: SdkGateHalf,
  measure: { readonly now: () => number; readonly timer: SdkGateTimer },
): GateWait | undefined {
  return budget === undefined ? undefined : { budget, half, ...measure }
}

interface Gate {
  acquire(signal: AbortSignal, wait?: GateWait): Promise<() => void>
  readonly held: number
  readonly waiting: number
  readonly idle: boolean
}

function createGate(limit: number): Gate {
  // Clamped rather than rejected: a misconfigured ceiling should throttle traffic, never stop it,
  // and a zero-permit semaphore would wedge every subscription request on this replica forever.
  const permits = Math.max(1, Math.floor(limit))
  let held = 0
  // A waiter's `admit` takes the permit and answers true, or finds its own deadline already past,
  // refuses itself and answers false.
  const queue = createWaiterQueue<() => boolean>()

  const release = (): void => {
    for (;;) {
      const next = queue.shift()
      // The permit is handed straight to the next waiter instead of being returned and re-taken:
      // `held` never dips, so a fresh caller cannot slip past the queue in between. A waiter whose
      // deadline passed before its timer got to run is not served (its client is owed the full-gate
      // answer it was promised): the permit goes to the next one.
      if (next === undefined) {
        held -= 1
        return
      }
      if (next()) return
    }
  }

  return {
    acquire: async (signal, wait) => {
      throwIfAborted(signal, NOT_GRANTED)
      if (held < permits) {
        held += 1
        return once(release)
      }
      // Nothing left to wait with: a full gate refuses at once, and queues nobody.
      if (wait !== undefined && wait.budget.remaining() <= 0)
        throw new SdkGateWaitExpiredError(wait.half)

      await new Promise<void>((resolve, reject) => {
        const queuedAt = wait?.now() ?? 0
        let timer: unknown
        // Every way out of the queue charges the time spent in it and disarms the timer.
        const leave = (): void => {
          signal.removeEventListener("abort", onAbort)
          if (wait === undefined) return
          wait.timer.clear(timer)
          wait.budget.spend(wait.now() - queuedAt)
        }
        const deadline = queuedAt + (wait?.budget.remaining() ?? 0)
        const expire = (half: SdkGateHalf): void => {
          place.remove()
          leave()
          reject(new SdkGateWaitExpiredError(half))
        }
        const admit = (): boolean => {
          if (wait !== undefined && wait.now() >= deadline) {
            expire(wait.half)
            return false
          }
          leave()
          resolve()
          return true
        }
        const onAbort = (): void => {
          place.remove()
          leave()
          reject(abortReason(signal, NOT_GRANTED))
        }
        signal.addEventListener("abort", onAbort, { once: true })
        const place = queue.push(admit)
        if (wait !== undefined)
          timer = wait.timer.set(() => expire(wait.half), wait.budget.remaining())
      })

      return once(release)
    },

    get held() {
      return held
    },
    get waiting() {
      return queue.size
    },
    get idle() {
      return held === 0 && queue.size === 0
    },
  }
}

function once(action: () => void): () => void {
  let done = false
  return () => {
    if (done) return
    done = true
    action()
  }
}
