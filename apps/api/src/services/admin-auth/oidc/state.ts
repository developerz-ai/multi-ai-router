import { createHash, randomBytes } from "node:crypto"
import type { OauthStateRepository } from "@multi-ai-router/db"
import type { CredentialCipher } from "../../crypto/cipher"

/**
 * Admin OIDC state rows — reused from {@link OauthStateRepository}. The
 * `oauth_states` table is the home for the one-shot `state` plus the PKCE
 * verifier and the OIDC `nonce` side by side. Both come back encrypted and
 * unreadable after the janitor sweeps.
 *
 * Bound to the admin flow by leaving `accountId` null and writing the
 * synthetic {@link ADMIN_OIDC_PROVIDER} value into `provider`. The legacy
 * account-connect flow always populates `accountId`; the admin flow never
 * does. The two streams never collide.
 *
 * The store returns plaintext values to the flow. Encryption is its concern,
 * not the flow's — the flow is the only place that knows how the two fields
 * are used at the same time, and the only place that doesn't need to think
 * about how they are protected at rest.
 */

const STATE_BYTES = 32
const NONCE_BYTES = 32
const VERIFIER_BYTES = 32

/**
 * A synthetic provider id that marks a row as belonging to the admin plane.
 * The `provider` column's enum does not include this value, so the column is
 * widened by the admin flow's repository: the admin OIDC is the only
 * non-provider writer today, and the cast here is the one place that knows.
 */
export const ADMIN_OIDC_PROVIDER = "admin-oidc"

export class OIDCStateMismatchError extends Error {
  constructor() {
    super("authorization state is no longer valid")
    this.name = "OIDCStateMismatchError"
  }
}

export interface IssuedState {
  readonly state: string
  readonly nonce: string
  readonly codeVerifier: string
  readonly expiresAt: Date
}

export interface ConsumedState {
  readonly nonce: string
  readonly codeVerifier: string
}

export interface OIDCStateStore {
  /** Mints a fresh state + nonce + PKCE verifier, storing all three. */
  issue(): Promise<IssuedState>
  /**
   * Redeems a state and returns the **plaintext** nonce and PKCE verifier.
   * Consumes the row. Throws {@link OIDCStateMismatchError} for any rejection —
   * the wording is the same as the account flow's, so the two cannot be
   * probed apart.
   */
  consume(state: string): Promise<ConsumedState>
}

export interface OIDCStateStoreDeps {
  readonly states: Pick<OauthStateRepository, "create" | "consume">
  readonly cipher: Pick<CredentialCipher, "encrypt" | "decrypt">
  /** Short TTL, in minutes. The legacy flow uses `env.retention.oauthStateMinutes`. */
  readonly stateMinutes: number
  readonly now: () => Date
}

export function createOIDCStateStore(deps: OIDCStateStoreDeps): OIDCStateStore {
  const ttlMs = deps.stateMinutes * 60_000

  return {
    async issue() {
      const state = randomBytes(STATE_BYTES).toString("base64url")
      const nonce = randomBytes(NONCE_BYTES).toString("base64url")
      const codeVerifier = randomBytes(VERIFIER_BYTES).toString("base64url")
      const expiresAt = new Date(deps.now().getTime() + ttlMs)
      await deps.states.create({
        state,
        codeVerifier: deps.cipher.encrypt(codeVerifier),
        nonce: deps.cipher.encrypt(nonce),
        // The provider enum does not include this value. The cast is the
        // single, named seam where the admin flow writes outside the
        // provider vocabulary — that is what the field's name is *for*.
        provider: ADMIN_OIDC_PROVIDER as unknown as Parameters<
          typeof deps.states.create
        >[0]["provider"],
        expiresAt,
      })
      return { state, nonce, codeVerifier, expiresAt }
    },

    async consume(state: string) {
      const row = await deps.states.consume(state, deps.now())
      if (row === undefined) throw new OIDCStateMismatchError()
      if (row.provider !== (ADMIN_OIDC_PROVIDER as unknown as typeof row.provider)) {
        throw new OIDCStateMismatchError()
      }
      if (row.nonce === null) throw new OIDCStateMismatchError()
      try {
        const nonce = deps.cipher.decrypt(row.nonce)
        const codeVerifier = deps.cipher.decrypt(row.codeVerifier)
        return { nonce, codeVerifier }
      } catch {
        throw new OIDCStateMismatchError()
      }
    },
  }
}

/** SHA-256 hashed so a hostile 1 KB string cannot grow the throttle map. */
export function ipThrottleNamespace(suffix: string): string {
  return `admin-oidc:${createHash("sha256").update(suffix, "utf8").digest("base64url")}`
}
