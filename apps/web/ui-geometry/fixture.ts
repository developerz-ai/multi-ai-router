import type { FixtureAccount, FixtureKey, WireTotals } from "./fixture-types"

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

/** Days-to-ms, for the timestamps below. */
const DAY = 86_400_000
/** 118 characters exactly — the reported worst-case label. */
const LONG_LABEL_BASE =
  "platform-relay-eu-west-primary-long-haul-account-with-an-operator-chosen-descriptive-name-"
const LONG_LABEL = (LONG_LABEL_BASE + "0".repeat(118)).slice(0, 118)
if (LONG_LABEL.length !== 118) {
  // The length is a fixture requirement, not an accident — #223 names 118 chars.
  throw new Error(`fixture label must be 118 chars, got ${LONG_LABEL.length}`)
}

/** The instant the browser clock is pinned to — relative dates render from it. */
export const NOW = Date.parse("2026-10-14T12:00:00Z")
const iso = (offsetMs: number): string => new Date(NOW + offsetMs).toISOString()

/** Seven daily buckets ending "now", oldest first — the shape `axis` promises. */
const AXIS = Array.from({ length: 7 }, (_, i) => iso((i - 6) * DAY))

const totals = (requests: number, metered: string, notional: string): WireTotals => ({
  requests,
  attempts: requests,
  errors: 0,
  tokensIn: requests * 4_096,
  tokensOut: requests * 1_024,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costMetered: metered,
  costNotional: notional,
})

const row = (id: string, label: string, t: WireTotals, series: readonly number[]) => ({
  id,
  label,
  note: null,
  totals: t,
  latencyP50Ms: 240,
  latencyP95Ms: 900,
  routerOverheadP95Ms: 2,
  series,
})

/** `GET /auth/session` — a live session, so the shell never redirects to /login. */
export const session = {
  username: "geometry-fixture",
  csrfToken: "fixture-csrf-token",
  issuedAt: iso(-3_600_000),
  expiresAt: iso(DAY),
}

/** `GET /settings` — only the footer's version line and the keys page read it. */
export const settings = {
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
export const providers = {
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
    id: "acc-subscription",
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
    id: "acc-api-key",
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
    id: "acc-long-label",
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
    id: "key-big-spender",
    name: "team-batch-pipeline",
    prefix: "mar_live_9f2Kd",
    owner: "ivann",
    ownerKind: "person",
    tool: "claude-code",
    purpose: "nightly evals",
  }),
  key({
    id: "key-revoked",
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
export const pools: readonly unknown[] = []

/** `GET /usage?window=7d` — totals plus the two breakdowns the tables join on. */
export const usage = {
  coverage: {
    timeBasis: "event-time",
    requestsBasis: "terminal",
    historicalPrecision: "day",
    legacy: false,
    incomplete: false,
    bucketWidth: DAY,
    maxChartPoints: 240,
    retainedDetail: {
      from: iso(-7 * DAY),
      to: iso(0),
      attempts: 1_000,
      totalAttempts: 1_000,
      partial: false,
    },
    breakdown: { maxRows: 20, truncated: [] },
  },
  window: "7d",
  bucket: "day",
  from: iso(-7 * DAY),
  to: iso(0),
  totals: totals(1_000, "46532.67", "188.15"),
  latency: { p50Ms: 240, p95Ms: 900, routerOverheadP95Ms: 2, ttfbP95Ms: 420 },
  failures: { attempts: 1_000, errors: 0, partial: false, byOutcome: [] },
  axis: AXIS,
  series: AXIS.map((at, i) => ({ at, requests: 100 + i * 10, attempts: 100 + i * 10, errors: 0 })),
  byKey: [
    // The five-digit spend: wide enough that a cramped COST column would push it
    // into the neighbouring cell — the exact regression this gate exists for.
    row(
      "key-big-spender",
      "team-batch-pipeline",
      totals(600, "45678.90", "0"),
      [80, 90, 100, 95, 110, 105, 20],
    ),
    row("key-revoked", "legacy-runner", totals(12, "34.56", "0"), [2, 2, 3, 1, 2, 1, 1]),
  ],
  byAccount: [
    row(
      "acc-subscription",
      "claude-max-1",
      totals(412, "0", "88.40"),
      [50, 60, 58, 62, 61, 70, 51],
    ),
    // Non-zero metered AND notional on a STORED-badge row: the collision #62 was.
    row(
      "acc-api-key",
      "anthropic-console-api",
      totals(588, "842.13", "96.25"),
      [90, 80, 85, 88, 79, 84, 82],
    ),
    row("acc-long-label", LONG_LABEL, totals(64, "12.00", "3.50"), [9, 10, 8, 11, 9, 10, 7]),
  ],
  byPool: [],
  byModel: [],
}
