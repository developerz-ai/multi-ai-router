import type { AuthMethods } from "../src/lib/api/auth"

/** Ids shared by the entities and their usage rows: a rename must move both or the join silently shows $0.00. */
export const ID = {
  accSubscription: "acc-subscription",
  accApiKey: "acc-api-key",
  accLongLabel: "acc-long-label",
  keyBigSpender: "key-big-spender",
  keyRevoked: "key-revoked",
} as const

/** `GET /auth/methods` — no sign-in door; the mocked session is already authenticated. */
export const authMethods: AuthMethods = { oidc: false, local: false }
