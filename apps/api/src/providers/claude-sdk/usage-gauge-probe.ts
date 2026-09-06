import { createCliProbe } from "./cli-probe"
import type { SdkConcurrency } from "./concurrency"
import type { CredentialFreshness } from "./credential-freshness"
import { type IdleQueryFn, openIdleQuery } from "./idle-query"
import { type CliResolution, resolveClaudeCli } from "./resolve-cli"
import type { SdkUsageGauge } from "./usage-gauge"

/**
 * The usage gauge, asked of an Account nothing is routing to.
 *
 * The request path reads the gauge off the turn it is already serving (`invoker.ts`); an account
 * that has served nothing today has no such turn, and the console would show it stale forever. This
 * opens the turn-free query `idle-query.ts` describes — the SDK's initialize handshake, and *no
 * prompt* — asks the one control question, and closes it. **Nothing is billed and no turn is
 * spent**: the operator's rule that checking on a subscription must never cost usage is what this
 * module exists to honour, and the idle-probe test asserts the prompt yields nothing.
 *
 * The cost is one `claude` subprocess per account per sweep, bounded by the same semaphore every
 * other spawner holds, and a missing binary takes no slot at all — the resolution runs first.
 */

export interface SdkUsageGaugeProbeOptions {
  readonly gauge: SdkUsageGauge
  readonly concurrency: SdkConcurrency
  /** Passed straight to `openIdleQuery`: this probe spawns, so it crosses the refresh window too. */
  readonly freshness?: CredentialFreshness
  /** `CLAUDE_CLI_PATH`, validated at the env boundary. Re-resolved per call — see `resolve-cli.ts`. */
  readonly cliPathOverride: string | null
  /** Bounds the slot wait, the handshake, and the read together. Config, never a constant. */
  readonly timeoutMs: number
  readonly resolveCli?: () => CliResolution
  readonly runQuery?: IdleQueryFn
}

export interface SdkUsageGaugeProbe {
  /**
   * Reads one Account's plan usage. Resolves `true` when a query was opened and the gauge asked
   * (whether or not it produced a reading), `false` when no `claude` binary is usable. Never throws:
   * a probe that fails is a reading not taken, and the sweep says so per account.
   */
  read(input: { readonly accountId: string; readonly configDir: string }): Promise<boolean>
}

export function createSdkUsageGaugeProbe(options: SdkUsageGaugeProbeOptions): SdkUsageGaugeProbe {
  const resolveCli =
    options.resolveCli ??
    (() => resolveClaudeCli(createCliProbe({ override: options.cliPathOverride })))

  return {
    read: async ({ accountId, configDir }) => {
      const resolution = resolveCli()
      if (!resolution.ok) return false

      const handle = await openIdleQuery({
        accountId,
        configDir,
        cliPath: resolution.path,
        concurrency: options.concurrency,
        ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
        timeoutMs: options.timeoutMs,
        ...(options.runQuery === undefined ? {} : { runQuery: options.runQuery }),
      })
      try {
        // The gauge's own timeout and coalescing apply; `observe` never rejects.
        await options.gauge.observe(accountId, handle.query)
      } finally {
        await handle.close()
      }
      return true
    },
  }
}
