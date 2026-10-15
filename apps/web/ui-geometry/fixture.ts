import type { SettingsView } from "../src/lib/api/settings"
import type { PoolView, ProviderListResponse, SessionView } from "../src/lib/api/types"
import { ID } from "./fixture-ids"
import { DAY, iso, LONG_LABEL, NOW } from "./fixture-time"
import type { FixtureAccount, FixtureKey } from "./fixture-types"

export { usage } from "./fixture-usage"
export { NOW }

// The admin-API fixture `bin/ui-geometry` serves to the built SPA from Playwright
// route mocks. Nothing here is real: no credential is valid, no host is reachable,
// and no router process exists during a gate run — the browser talks to a static
// file server plus these mocks, so "no request reaches a provider and no `claude`
// subprocess spawns" is structural (there is no API and no DB to spawn one), not
// observed.
//
// The rows exist to stress the exact geometry that once broke (#62, undone by #94):
// a STORED credential pill beside non-zero metered *and* notional figures, a
// subscription row whose plan pill and login line compete for the same column, a
// 118-character label forcing the identity column wide, and a key with a
// five-digit spend forcing the COST column wide. Notional spend on an API-key
// account is synthetic by design: notional is attributed to subscription-basis
// usage rows, and a geometry fixture may seed it directly rather than through
// traffic.

/** `GET /auth/session` — a live session, so the shell never redirects to /login. */
export const session: SessionView = {
  username: "geometry-fixture",
  csrfToken: "fixture-csrf-token",
  issuedAt: iso(-3_600_000),
  expiresAt: iso(DAY),
}

/** `GET /settings` — only the footer's version line and the keys page read it. */
export const settings: SettingsView = {
  version: "9.9.9-geometry-fixture",
  retention: {
    usageDays: 30,
    auditDays: 90,
    sessionsHours: 24,
    revokedKeysDays: 30,
    oauthStateMinutes: 10,
  },
  logLevel: "info",
  janitorIntervalMinutes: 15,
  prices: { shippedAsOf: "2026-10-01", shipped: [], overrides: [] },
  publicUrl: null,
}

/**
 * `GET /providers` — the two descriptors the fixture's accounts need. The subscription row is
 * declared agent-SDK with `requiresConfigDir`, and the account below carries `configDir: null`:
 * in a real deployment that is exactly the row the CLI can never be spawned for.
 */
export const providers: ProviderListResponse = {
  providers: [
    {
      id: "anthropic-oauth",
      transport: "agent-sdk",
      authKind: "oauth",
      nativeDialect: "anthropic",
      supportedDialects: ["anthropic", "openai-chat", "openai-responses"],
      requiresBaseUrl: false,
      requiresConfigDir: true,
      defaultBilling: "subscription",
      billingFixed: true,
      connectFlow: "claude-cli",
      deviceSignIn: false,
      creatable: true,
      reason: null,
    },
    {
      id: "anthropic-api",
      transport: "http",
      authKind: "api-key",
      nativeDialect: "anthropic",
      supportedDialects: ["anthropic", "openai-chat", "openai-responses"],
      requiresBaseUrl: true,
      requiresConfigDir: false,
      defaultBilling: "metered",
      billingFixed: false,
      connectFlow: null,
      deviceSignIn: false,
      creatable: true,
      reason: null,
    },
  ],
}

const account = (
  over: Partial<FixtureAccount> & Pick<FixtureAccount, "id" | "label" | "provider">,
): FixtureAccount => ({
  status: "active",
  hasCredential: false,
  // Null on purpose across the board: an agent-SDK account with no config
  // directory is the one shape that can never reach a `claude` CLI, and null is
  // also the honest value for a row that was never provisioned.
  configDir: null,
  baseUrl: null,
  dialect: "anthropic",
  modelAliases: null,
  supportedModels: null,
  windowTokenLimits: null,
  weight: 1,
  priority: 1,
  billing: "metered",
  tokenExpiresAt: null,
  lastUsedAt: iso(-86_400_000),
  createdAt: iso(-90 * DAY),
  updatedAt: iso(-DAY),
  ...over,
})

/** `GET /accounts` — see the module comment for what each row is for. */
export const accounts: readonly FixtureAccount[] = [
  account({
    id: ID.accSubscription,
    label: "claude-max-1",
    provider: "anthropic-oauth",
    billing: "subscription",
    lastUsedAt: iso(-7_200_000),
    credential: {
      expiresAt: iso(25 * DAY),
      subscriptionType: "max",
      rateLimitTier: "default_claude_max_20x",
      present: true,
      accessTokenExpiresAt: iso(6 * 3_600_000),
      lastLoginAt: iso(-5 * DAY),
      renewsAt: iso(25 * DAY),
      renewsAtSource: "reported",
      daysUntilRenewal: 25,
      renewalRequiredSoon: false,
      renewalWarnDays: 7,
    },
  }),
  account({
    id: ID.accApiKey,
    label: "anthropic-console-api",
    provider: "anthropic-api",
    hasCredential: true,
    // A dead localhost port, kept for honesty: in a deployment this base URL is
    // the only upstream an HTTP account could ever dial, and port 9 (discard)
    // answers nothing.
    baseUrl: "http://127.0.0.1:9",
    lastUsedAt: iso(-3_600_000),
    createdAt: iso(-120 * DAY),
    updatedAt: iso(-2 * DAY),
  }),
  account({
    id: ID.accLongLabel,
    label: LONG_LABEL,
    provider: "anthropic-api",
    hasCredential: true,
    baseUrl: "http://127.0.0.1:9",
    priority: 2,
    createdAt: iso(-30 * DAY),
  }),
]

/** `GET /keys` — one five-digit spender, one revoked, so both State badge tones render. */
const key = (over: Partial<FixtureKey> & Pick<FixtureKey, "id" | "name">): FixtureKey => ({
  prefix: "mar_live_xxxxx",
  owner: null,
  ownerKind: null,
  tool: null,
  purpose: null,
  scope: { kind: "all", poolIds: [], accountIds: [] },
  rateLimit: null,
  expiresAt: null,
  revoked: false,
  revokedAt: null,
  lastUsedAt: iso(-7_200_000),
  createdAt: iso(-60 * DAY),
  updatedAt: iso(-DAY),
  ...over,
})

export const keys: readonly FixtureKey[] = [
  key({
    id: ID.keyBigSpender,
    name: "team-batch-pipeline",
    prefix: "mar_live_9f2Kd",
    owner: "fixture-owner",
    ownerKind: "person",
    tool: "claude-code",
    purpose: "nightly evals",
  }),
  key({
    id: ID.keyRevoked,
    name: "legacy-runner",
    prefix: "mar_live_old01",
    scope: { kind: "pools", poolIds: ["pool-1"], accountIds: [] },
    revoked: true,
    revokedAt: iso(-10 * DAY),
    lastUsedAt: iso(-11 * DAY),
    createdAt: iso(-200 * DAY),
    updatedAt: iso(-10 * DAY),
  }),
]

/** `GET /pools` — empty; nothing on either table needs a member to render. */
export const pools: readonly PoolView[] = []
