import { describeError } from "@multi-ai-router/core"
import type { ScheduledTask, TaskContext, TaskOutcome } from "../types"

/**
 * The egress proxy check: asks whether each account's proxy still works and, for an account whose
 * operator allowed it, moves it off a dead one (docs/idea/03-providers.md#egress-proxy).
 *
 * The task is only the schedule. Everything it does — the vendor listing, the CONNECT probe, the
 * repair decision and its compare-and-swap — is `services/accounts/egress`, handed in as one port,
 * so the scheduler owns no proxy logic and the rule "only a listing or a probe writes proxy health"
 * has one home. Idempotent and bounded there: a sweep takes the least recently checked accounts
 * first and reports `partial` when it stopped short.
 */

/** What one sweep did. `checked` is the task's `itemsProcessed`. */
export interface EgressSweepReport {
  readonly checked: number
  readonly failed: number
  readonly reseals: number
  readonly swaps: number
  readonly noCandidate: number
  /** More is due: the batch overflowed, or a vendor was unavailable while an account needed it. */
  readonly partial?: boolean
}

export interface EgressProxyCheckPorts {
  sweep(ctx: TaskContext): Promise<EgressSweepReport>
  /** `EGRESS_PROXY_CHECK_INTERVAL_MINUTES`, in milliseconds. The runner jitters it. */
  readonly intervalMs: number
}

/** No ports, no task: a deployment with nothing wired gets none rather than one that ticks idle. */
export function createEgressProxyCheckTasks(
  ports: EgressProxyCheckPorts | undefined,
): readonly ScheduledTask[] {
  return ports === undefined ? [] : [createEgressProxyCheckTask(ports)]
}

export function createEgressProxyCheckTask(ports: EgressProxyCheckPorts): ScheduledTask {
  return {
    name: "egress_proxy_check",
    intervalMs: ports.intervalMs,

    run: async (ctx): Promise<TaskOutcome> => {
      let report: EgressSweepReport
      try {
        report = await ports.sweep(ctx)
      } catch (error) {
        // The sweep commits per account, so a throw says nothing about what already landed.
        return {
          outcome: "failed",
          itemsProcessed: 0,
          error: describeError(error, Number.POSITIVE_INFINITY),
        }
      }
      // Quiet when there was nothing to look at: most deployments have no proxied account.
      if (report.checked > 0)
        ctx.logger.info("egress proxy check", {
          checked: report.checked,
          failed: report.failed,
          reseals: report.reseals,
          swaps: report.swaps,
          noCandidate: report.noCandidate,
        })
      return {
        outcome: report.partial === true || ctx.signal.aborted ? "partial" : "success",
        itemsProcessed: report.checked,
      }
    },
  }
}
