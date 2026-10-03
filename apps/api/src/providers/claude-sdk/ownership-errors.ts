export class CredentialMetadataOwnershipUnavailable extends Error {
  constructor() {
    super("credential metadata ownership unavailable")
    this.name = "CredentialMetadataOwnershipUnavailable"
  }
}
