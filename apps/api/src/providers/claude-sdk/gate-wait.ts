/**
 * The bounded wait at the Claude subprocess gate (`concurrency.ts`).
 *
 * A request that cannot get a slot within `CLAUDE_SDK_QUEUE_WAIT_MS` is given an explicit answer
 * instead of waiting silently until its attempt deadline: a client that cuts a silent call at
 * 300 s would otherwise read a long gate wait as a timeout nobody can explain. The budget belongs to
 * the **request**, not the attempt, so a walk over N full accounts costs one knob in total and not N
 * of them. A caller that passes none keeps the unbounded queue (the probe, the keepalive).
 */

/** The half of the two-gate pair a caller was still queued on when its budget ran out. */
export type SdkGateHalf = "account" | "global"

/** What a request still has to wait with. Mutable on purpose: every acquire of one request draws on it. */
export interface SdkWaitBudget {
  /** Milliseconds of queueing left. Never negative. */
  remaining(): number
  /** Charges time actually spent queued. Called by the gate, never by a caller. */
  spend(milliseconds: number): void
}

export function createSdkWaitBudget(totalMs: number): SdkWaitBudget {
  let left = Math.max(0, totalMs)
  return {
    remaining: () => left,
    spend: (milliseconds) => {
      left = Math.max(0, left - Math.max(0, milliseconds))
    },
  }
}

/** The timer the gate arms for a budgeted wait. Injected so a test drives it without real time. */
export interface SdkGateTimer {
  set(fire: () => void, milliseconds: number): unknown
  clear(handle: unknown): void
}

/** The clock and timer a gate measures its budgets with. Both default to the real ones. */
export interface SdkGateClocks {
  /** Milliseconds, monotonic. */
  readonly now?: () => number
  readonly timer?: SdkGateTimer
}

export const REAL_GATE_TIMER: SdkGateTimer = {
  set: (fire, milliseconds) => setTimeout(fire, milliseconds),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * A budgeted caller ran out of wait before the gate admitted it. Typed so the attempt can tell a
 * full gate from a crashed subprocess: `half` says which gate was full, and so whose fault it is
 * (one account's in-flight limit, or the replica's whole subprocess ceiling).
 */
export class SdkGateWaitExpiredError extends Error {
  readonly half: SdkGateHalf

  constructor(half: SdkGateHalf) {
    super(
      half === "account"
        ? "no Claude subprocess slot for this account became free within the queue wait (CLAUDE_SDK_QUEUE_WAIT_MS)"
        : "no Claude subprocess slot on this replica became free within the queue wait (CLAUDE_SDK_QUEUE_WAIT_MS)",
    )
    this.name = "SdkGateWaitExpiredError"
    this.half = half
  }
}
