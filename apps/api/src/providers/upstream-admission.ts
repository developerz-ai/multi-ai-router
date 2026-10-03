/** A local admission verdict before an upstream call exists. Never an account failure. */
export class UpstreamAdmissionRefused extends Error {
  constructor(message = "upstream admission refused") {
    super(message)
    this.name = "UpstreamAdmissionRefused"
  }
}

export type UpstreamStartGuard = (() => void) & { readonly singleStart?: boolean }

/** Offpath background work revalidates durable eligibility after preparation waits. */
export type AsyncBackgroundStartGuard = () => Promise<void>
