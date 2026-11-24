import { UpstreamAdmissionRefused } from "../upstream-admission"
import type { SdkConcurrency, SdkSlot } from "./concurrency"
import {
  ALWAYS_FRESH,
  type CredentialFreshness,
  type CredentialRefreshClaim,
} from "./credential-freshness"
import type { CliResolution } from "./resolve-cli"
import type { SdkTestProbeInput, SdkTestProbeResult } from "./test-probe"

export type PreparedSdkProbe =
  | {
      readonly ok: true
      readonly path: string
      readonly slot: SdkSlot
      /** The refresh-window claim taken before the slot — released beside it when the turn ends. */
      readonly releaseRefreshClaim: () => void
    }
  | { readonly ok: false; readonly result: SdkTestProbeResult }
export async function prepareSdkProbe(
  input: SdkTestProbeInput,
  deps: {
    readonly resolveCli: () => CliResolution
    readonly freshness?: CredentialFreshness
    readonly concurrency: SdkConcurrency
    readonly ceilingMessage: string
  },
): Promise<PreparedSdkProbe> {
  const background = input.beforeBackgroundUpstreamStart !== undefined
  let resolution: CliResolution
  try {
    resolution = deps.resolveCli()
  } catch (error) {
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    throw error
  }
  if (!resolution.ok) {
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    return {
      ok: false,
      result: {
        ok: false,
        message: "this router has no usable claude binary to spawn — see /readyz",
        rateLimitInfos: [],
      },
    }
  }
  const freshness = deps.freshness ?? ALWAYS_FRESH
  let claim: CredentialRefreshClaim
  try {
    claim = await freshness.ensureFresh(input.accountId, input.signal)
  } catch (error) {
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    throw error
  }
  let slot: SdkSlot
  try {
    slot = await deps.concurrency.acquire(input.accountId, input.signal)
  } catch {
    claim.release()
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    return { ok: false, result: { ok: false, message: deps.ceilingMessage, rateLimitInfos: [] } }
  }
  // Re-asked with the slot in hand, as a client's turn does (`turn-admission.ts`): a token warm when
  // this probe queued can be inside the CLI's refresh lead by the time it spawns, and spawning then
  // without the window is a second spender of a rotating refresh token.
  try {
    const rechecked = await freshness.ensureFresh(input.accountId, input.signal, claim)
    return {
      ok: true,
      path: resolution.path,
      slot,
      releaseRefreshClaim: () => {
        rechecked.release()
        claim.release()
      },
    }
  } catch (error) {
    slot.release()
    claim.release()
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    throw error
  }
}
