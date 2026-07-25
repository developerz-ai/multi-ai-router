import type { ProviderId } from "@multi-ai-router/core"
import { and, eq, gt, isNull } from "drizzle-orm"
import type { Database } from "../client"
import { type OauthStateRow, oauthStates } from "../schema/oauth-states"
import { deleteOldestBatch } from "./bounded-delete"

/**
 * The one-shot OAuth `state` + PKCE verifier. Repositories own SQL; this file is
 * the only place that knows `oauth_states` is a table.
 *
 * **Ciphertext in, ciphertext out.** `codeVerifier` crosses this boundary as the
 * AES-256-GCM envelope and nothing else — the service layer encrypts before
 * `create` and decrypts after `consume`, exactly as it does for
 * `accounts.authMaterial`. Encryption is not a `packages/db` concern
 * (docs/reusable-code.md).
 *
 * Claude subscription accounts never appear here: their login is handed to the
 * `claude` CLI and lands in the account's `CLAUDE_CONFIG_DIR`.
 */
export interface OauthStateRepository {
  /** `input.codeVerifier` must already be an encryption envelope, never the raw verifier. */
  create(input: CreateOauthStateInput): Promise<OauthStateRow>
  /**
   * Redeems a state exactly once, atomically, and returns the row that was
   * redeemed.
   *
   * `undefined` covers every rejection — unknown, already consumed, or expired —
   * and the caller must not try to tell them apart: an authorization callback
   * that explains *why* it refused is a probe oracle, and the operator-facing
   * answer is the same in all three cases.
   *
   * The check and the write are one UPDATE on purpose. Reading the row, deciding
   * it is fresh, then stamping it leaves a window in which two concurrent
   * presentations of the same `state` both pass — which is the whole attack this
   * table exists to stop.
   */
  consume(state: string, now: Date): Promise<OauthStateRow | undefined>
  /**
   * Consumes every still-live state bound to one account and returns how many
   * there were, so restarting a connect flow — or abandoning it — leaves nothing
   * redeemable behind.
   *
   * Consumed rather than deleted, for the same reason `consume` stamps instead
   * of deleting: until the TTL runs out the row is what makes a replay a
   * rejection rather than a miss.
   */
  abandonForAccount(accountId: string, now: Date): Promise<number>
  /**
   * Deletes expired states in one bounded batch, oldest first, and returns how
   * many went. Exactly `limit` means there is more and the run should report
   * `partial`.
   *
   * Consumed-but-unexpired rows deliberately stay: until the TTL runs out they
   * are the record that makes a replayed `state` a rejection rather than a miss.
   */
  deleteExpiredBefore(cutoff: Date, limit: number): Promise<number>
}

export interface CreateOauthStateInput {
  /** The opaque value handed to the provider and compared on the way back. */
  readonly state: string
  /** AES-256-GCM envelope of the PKCE `code_verifier`. Never plaintext. */
  readonly codeVerifier: string
  readonly provider: ProviderId
  /** The pending account row this flow belongs to. */
  readonly accountId?: string | null
  /**
   * The `redirect_uri` the authorization request carried, which the code exchange must replay
   * byte for byte. Stored rather than re-derived, so a `PUBLIC_URL` edited mid-flow cannot make
   * the exchange disagree with the authorization it belongs to.
   */
  readonly redirectUri?: string | null
  /** Short TTL, from config — the spec's window is 10 minutes. */
  readonly expiresAt: Date
}

export function createOauthStateRepository(db: Database): OauthStateRepository {
  return {
    create: async (input) => {
      const rows = await db
        .insert(oauthStates)
        .values({
          state: input.state,
          codeVerifier: input.codeVerifier,
          provider: input.provider,
          accountId: input.accountId ?? null,
          redirectUri: input.redirectUri ?? null,
          expiresAt: input.expiresAt,
        })
        .returning()
      const row = rows[0]
      if (row === undefined) {
        // An `insert ... returning` always yields its row; nothing here is a
        // request outcome, so this is a plain Error rather than a `RouterError`.
        throw new Error("oauthStateRepository.create: statement returned no row")
      }
      return row
    },

    consume: async (state, now) => {
      const rows = await db
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthStates.state, state),
            isNull(oauthStates.consumedAt),
            gt(oauthStates.expiresAt, now),
          ),
        )
        .returning()
      return rows[0]
    },

    // No index on `account_id`, deliberately: the table holds one row per connect attempt against
    // a 10-minute TTL that the janitor sweeps, so this is a scan of a handful of rows on the admin
    // plane. An index would cost every insert to save nothing measurable.
    abandonForAccount: async (accountId, now) => {
      const rows = await db
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthStates.accountId, accountId),
            isNull(oauthStates.consumedAt),
            gt(oauthStates.expiresAt, now),
          ),
        )
        .returning({ id: oauthStates.id })
      return rows.length
    },

    // Rides `oauth_states_expires_at_idx`.
    deleteExpiredBefore: (cutoff, limit) =>
      deleteOldestBatch({
        db,
        table: oauthStates,
        id: oauthStates.id,
        agedBy: oauthStates.expiresAt,
        cutoff,
        limit,
      }),
  }
}
