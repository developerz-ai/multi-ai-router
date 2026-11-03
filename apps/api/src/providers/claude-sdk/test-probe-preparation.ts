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
  let claim: CredentialRefreshClaim
  try {
    claim = await (deps.freshness ?? ALWAYS_FRESH).ensureFresh(input.accountId, input.signal)
  } catch (error) {
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    throw error
  }
  try {
    const slot = await deps.concurrency.acquire(input.accountId, input.signal)
    return { ok: true, path: resolution.path, slot, releaseRefreshClaim: claim.release }
  } catch {
    claim.release()
    if (background) throw new UpstreamAdmissionRefused("SDK probe preparation unavailable")
    return { ok: false, result: { ok: false, message: deps.ceilingMessage, rateLimitInfos: [] } }
  }
}
