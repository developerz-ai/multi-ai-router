import type { Env } from "../../config/env"
import type { Logger } from "../../logging/logger"
import { type DrainableServer, drainServer } from "./drain"
import type { Lifecycle } from "./lifecycle"
import { installFailureAwareShutdownHandlers } from "./run-phases"

/**
 * Keep serving for a moment while the load balancer reads the `503` `/readyz` already returns.
 *
 * The latch is set the instant the signal arrives, so the endpoint is honest from that moment — but
 * an honest answer only helps somebody who can still ask. Once `Bun.serve().stop()` runs the
 * listener refuses new connections *and* stops dispatching on the keep-alive connections it already
 * had (measured against bun 1.3, re-measured on 1.4.0), so without this window the flip has nobody left to tell.
 *
 * Zero by default and therefore skipped entirely: the bundled compose deployment has no readiness
 * gate, and a wait that helps nobody there is just a slower shutdown.
 */
export async function announceUnready(env: Env, logger: Logger): Promise<void> {
  if (env.shutdownReadyGraceMs === 0) return
  logger.info("readiness withdrawn — still serving while the load balancer notices", {
    component: "transport",
    graceMs: env.shutdownReadyGraceMs,
  })
  await Bun.sleep(env.shutdownReadyGraceMs)
}

/**
 * Stop accepting, then give what is already in flight a bounded chance to finish.
 *
 * The bound is the point. `Bun.serve().stop()` waits for the last byte of the last response and
 * never gives up, so awaiting it bare hands the exit to the orchestrator's `SIGKILL` — which
 * truncates the streams the wait was protecting and loses every usage row, quota reading and
 * standing block still queued behind it. See `services/shutdown/drain.ts`.
 */
export async function drain(server: DrainableServer, env: Env, logger: Logger): Promise<void> {
  const outcome = await drainServer({ server, timeoutMs: env.shutdownDrainMs })
  const detail = {
    component: "transport",
    pending: outcome.pending,
    waitedMs: Math.round(outcome.waitedMs),
    timeoutMs: env.shutdownDrainMs,
  }

  if (outcome.timedOut) {
    logger.warn("drain deadline expired — closing responses still in flight", {
      ...detail,
      abandoned: outcome.abandoned,
      remedy:
        "raise SHUTDOWN_DRAIN_MS, and the orchestrator's stop grace period (stop_grace_period, terminationGracePeriodSeconds) above it",
    })
    return
  }
  logger.info("in-flight requests drained", detail)
}

/**
 * One shutdown, however many signals arrive.
 *
 * The drain is deliberately long, which makes a second signal likely: an orchestrator escalating,
 * or an operator pressing Ctrl-C again. Re-entering would run the flush twice and close the pool
 * underneath the first pass, so the second signal does the only thing it can honestly mean —
 * stop waiting, now — and exits non-zero, because work was abandoned.
 *
 * `lifecycle.begin()` is what recognises the second one, and it latches before a byte of the
 * shutdown runs: the same instant makes `/readyz` answer `503`, which is the point of doing it
 * here rather than inside the drain.
 */
export function installShutdownHandlers(
  lifecycle: Lifecycle,
  logger: Logger,
  shutdown: () => Promise<boolean>,
): void {
  installFailureAwareShutdownHandlers({
    lifecycle,
    shutdown,
    signals: {
      on: (signal, callback) => {
        process.on(signal, callback)
      },
      exit: (code) => process.exit(code),
    },
    log(kind, signal) {
      if (kind === "starting") logger.info("shutting down", { component: "transport", signal })
      else if (kind === "repeated")
        logger.warn("second signal while shutting down — exiting without finishing the drain", {
          component: "transport",
          signal,
        })
      else
        logger.error("shutdown failed", {
          component: "transport",
          signal,
          errorClass: "shutdown_failure",
        })
    },
  })
}
