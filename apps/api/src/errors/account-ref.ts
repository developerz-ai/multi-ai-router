import { createHash } from "node:crypto"

/**
 * The opaque name a client sees for an account: `acct_` and 16 hex characters of the SHA-256 of
 * its router id. Stable across requests and replicas, so a caller can tell "the same account
 * again" from "a sibling", and an operator can match it by hashing an id from the console. It is
 * neither the label nor the row id: neither an operator's naming nor the admin API's keys reach a
 * router-key holder through it. Unkeyed on purpose: ids are random UUIDs, so the digest reveals
 * nothing, and a key would make the reference change the day `ENCRYPTION_KEY` rotates.
 */
export function opaqueAccountRef(accountId: string): string {
  return `acct_${createHash("sha256").update(accountId).digest("hex").slice(0, 16)}`
}
