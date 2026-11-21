import { UpstreamAdmissionRefused } from "../upstream-admission"
import type { CredentialOwnerLaunchFailed } from "./owner-helper"

export class CredentialMetadataOwnershipUnavailable extends Error {
  /** Set when the owner's guardian was never spawned — see `owner-helper.ts` for the reasons. */
  constructor(readonly launchFailure?: CredentialOwnerLaunchFailed) {
    super("credential metadata ownership unavailable")
    this.name = "CredentialMetadataOwnershipUnavailable"
  }
}

/**
 * A refresh window that could not be fenced by the cross-replica lease. Distinct from an unownable
 * metadata guardian: this Account's credential may be perfectly readable, but no replica here may
 * spend its rotating refresh token without the lease.
 */
export class CredentialRefreshLeaseUnavailable extends UpstreamAdmissionRefused {
  constructor(message = "credential refresh lease unavailable", options?: ErrorOptions) {
    super(message, options)
    this.name = "CredentialRefreshLeaseUnavailable"
  }
}
