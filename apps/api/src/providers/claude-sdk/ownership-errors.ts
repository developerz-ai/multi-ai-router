import type { CredentialOwnerLaunchFailed } from "./owner-helper"

export class CredentialMetadataOwnershipUnavailable extends Error {
  /** Set when the owner's guardian was never spawned — see `owner-helper.ts` for the reasons. */
  constructor(readonly launchFailure?: CredentialOwnerLaunchFailed) {
    super("credential metadata ownership unavailable")
    this.name = "CredentialMetadataOwnershipUnavailable"
  }
}
