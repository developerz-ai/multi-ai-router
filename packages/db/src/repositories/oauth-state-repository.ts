import type { ProviderId } from "@multi-ai-router/core"
import { and, asc, eq, gt, inArray, isNull, lt } from "drizzle-orm"
import type { Database } from "../client"
import { type OauthStateRow, oauthStates } from "../schema/oauth-states"

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
  /** Absent for the manual `code#state` paste mode, which has no redirect. */
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

    // Deleted by id from an ordered, limited subselect: Postgres has no LIMIT on
    // DELETE, and an unbounded delete would hold locks across the whole table.
    // The subselect rides `oauth_states_expires_at_idx`.
    deleteExpiredBefore: async (cutoff, limit) => {
      const stale = db
        .select({ id: oauthStates.id })
        .from(oauthStates)
        .where(lt(oauthStates.expiresAt, cutoff))
        .orderBy(asc(oauthStates.expiresAt))
        .limit(limit)
      const rows = await db
        .delete(oauthStates)
        .where(inArray(oauthStates.id, stale))
        .returning({ id: oauthStates.id })
      return rows.length
    },
  }
}
