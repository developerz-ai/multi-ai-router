import { isAbsolute } from "node:path"
import { z } from "zod"
import { adminApiTokenProblem } from "../services/admin-auth"
import { ADMIN_BODY_ENV_FIELDS } from "./admin-bodies"
import { BACKGROUND_ENV_FIELDS } from "./background"
import { CLI_OWNERSHIP_ENV_FIELDS } from "./cli-ownership"
import { LOG_LEVELS } from "./env-defaults"
import {
  absoluteUrl,
  atLeastOne,
  encryptionKey,
  flag,
  fraction,
  nonEmpty,
  oidcScopes,
  oidcUrl,
  pathList,
  serverIdleTimeoutSeconds,
  usageBatchSize,
  wholeNumber,
} from "./fields"
import { METRIC_INVENTORY_ENV_FIELDS } from "./metric-inventory"
import { validateNumericBounds } from "./numeric-bounds"
import { RECOVERY_ENV_FIELDS } from "./recovery"
import { RELAY_LIFETIME_ENV_FIELDS } from "./relay-lifetimes"
import { USAGE_READ_ENV_FIELDS } from "./usage-read"

/**
 * Every variable this module parses, deliberately kept as a flat list of names and parsers: the
 * *reason* a given knob is bounded the way it is belongs in
 * docs/idea/09-deployment.md#environment-reference, which is where an operator reading the error
 * message will go, and restating it here is how the two start to disagree.
 *
 * Which parser each numeric field takes is not free choice — `fields.ts` states the rule and
 * `ZERO_IS_LEGAL` lists its exceptions. Exported as the shape rather than only as the built
 * schema so the drift guard in `test/unit/env.test.ts` can walk it field by field and refuse a
 * numeric knob that is neither bounded nor explained. Adding one below is therefore a decision
 * about zero, whether or not anyone remembered to make one.
 */
export const ENV_FIELDS = {
  ...ADMIN_BODY_ENV_FIELDS,
  ...USAGE_READ_ENV_FIELDS,
  ...BACKGROUND_ENV_FIELDS,
  ...RELAY_LIFETIME_ENV_FIELDS,
  ...METRIC_INVENTORY_ENV_FIELDS,
  ...CLI_OWNERSHIP_ENV_FIELDS,
  ...RECOVERY_ENV_FIELDS,
  PORT: wholeNumber.refine((value) => value <= 65_535, "must be at most 65535").optional(),
  SERVER_IDLE_TIMEOUT_SECONDS: serverIdleTimeoutSeconds.optional(),
  SHUTDOWN_DRAIN_MS: wholeNumber.optional(),
  SHUTDOWN_READY_GRACE_MS: wholeNumber.optional(),
  DATABASE_URL: nonEmpty,
  DB_POOL_MAX: atLeastOne.optional(),
  DB_POOL_IDLE_TIMEOUT_SECONDS: wholeNumber.optional(),
  DB_POOL_CONNECT_TIMEOUT_SECONDS: atLeastOne.optional(),
  DB_POOL_MAX_LIFETIME_SECONDS: wholeNumber.optional(),
  DB_POOL_CLOSE_TIMEOUT_SECONDS: wholeNumber.optional(),
  // === Admin OIDC ===
  // One of two ways to obtain an admin session — the other is the local admin
  // password (`bin/admin set-password`, an argon2id hash in Postgres). The four
  // fields below are all-or-nothing: all absent means "OIDC off, local login
  // only" and is legal here, because "OIDC or local" needs the database and is
  // therefore checked after migrations (`services/admin-auth/boot.ts`). A
  // *partial* block is an operator mistake and fails fast, with a message
  // pointing at docs/idea/13-admin-oidc.md.
  //
  // The required fields are parsed as optional so the `.transform` step can
  // raise a single, doc-pointing message for every missing field rather than
  // the per-field "is required" line `nonEmpty` would otherwise emit. The
  // `nonEmpty` would win on first write because `toEnvValidationError` keeps
  // only the first issue per path, which is the wrong ordering for a doc
  // pointer.
  ADMIN_OIDC_ISSUER_URL: oidcUrl
    .refine((value) => !URL.parse(value)?.search, "must not contain a query string")
    .optional(),
  ADMIN_OIDC_CLIENT_ID: z.string().optional(),
  ADMIN_OIDC_CLIENT_SECRET: z.string().optional(),
  ADMIN_OIDC_REDIRECT_URI: oidcUrl.optional(),
  ADMIN_OIDC_ADMIN_EMAIL: z.string().optional(),
  ADMIN_OIDC_ADMIN_SUBJECT: z.string().optional(),
  ADMIN_OIDC_SCOPES: oidcScopes.optional(),
  ADMIN_OIDC_CLOCK_SKEW_SECONDS: atLeastOne.optional(),
  ADMIN_OIDC_REQUEST_TIMEOUT_MS: atLeastOne.optional(),
  // The named opt-out of the fail-closed loopback rule for the local admin
  // password — see `services/admin-auth/boot.ts`. Off by default, on purpose.
  ADMIN_LOCAL_LOGIN_ALLOW_PUBLIC: flag.optional(),
  ENCRYPTION_KEY: encryptionKey,
  LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  // Refuses zero: a zero-length reason logs failures with no reason at all — a silent absence.
  LOG_REASON_MAX_CHARS: atLeastOne.optional(),
  LOG_QUIET_PATHS: pathList.optional(),
  TRUST_PROXY: flag.optional(),
  SENTRY_DSN: z.string().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  PUBLIC_URL: absoluteUrl.optional(),
  ROUTER_REVISION: nonEmpty.optional(),
  WEB_ROOT: nonEmpty.optional(),
  CLAUDE_CONFIG_ROOT: nonEmpty.refine(isAbsolute, "must be an absolute path").optional(),
  CLAUDE_CLI_PATH: nonEmpty.optional(),
  CLAUDE_SDK_MAX_CONCURRENCY: atLeastOne.optional(),
  CLAUDE_SDK_MAX_CONCURRENCY_PER_ACCOUNT: atLeastOne.optional(),
  CLAUDE_SDK_CREDENTIAL_KEEPALIVE: flag.optional(),
  CLAUDE_SDK_CREDENTIAL_COLD_MARGIN_SECONDS: wholeNumber.optional(),
  CLAUDE_SDK_CREDENTIAL_REFRESH_SKEW_SECONDS: wholeNumber.optional(),
  CLAUDE_SDK_CREDENTIAL_REFRESH_WAIT_MS: atLeastOne.optional(),
  CLAUDE_SDK_CREDENTIAL_REFRESH_POLL_MS: atLeastOne.optional(),
  CLAUDE_SDK_USAGE_GAUGE: flag.optional(),
  CLAUDE_SDK_USAGE_GAUGE_TIMEOUT_MS: atLeastOne.optional(),
  CLAUDE_SDK_USAGE_GAUGE_MIN_INTERVAL_SECONDS: wholeNumber.optional(),
  METRICS_TOKEN: nonEmpty.optional(),
  // Refused by name at boot when too short to resist guessing, or when it wears the router-key
  // prefix — the admin guard rejects that prefix outright, so such a token would authenticate
  // nothing and look correct while doing it. Both rules live in `admin-auth/apiToken.ts`.
  ADMIN_API_TOKEN: nonEmpty
    .superRefine((value, ctx) => {
      const problem = adminApiTokenProblem(value)
      if (problem !== null) ctx.addIssue({ code: "custom", message: problem })
    })
    .optional(),
  ACCOUNT_RECHECK_COOLDOWN_SECONDS: wholeNumber.optional(),
  ACCOUNT_TEST_NOW_COOLDOWN_SECONDS: wholeNumber.optional(),
  ADMIN_CREDENTIAL_METADATA_TTL_SECONDS: wholeNumber.optional(),
  RETENTION_SESSIONS_HOURS: atLeastOne.optional(),
  RETENTION_USAGE_DAYS: atLeastOne.optional(),
  RETENTION_USAGE_DAILY_DAYS: atLeastOne.optional(),
  RETENTION_AUDIT_DAYS: atLeastOne.optional(),
  RETENTION_TASK_RUNS_DAYS: atLeastOne.optional(),
  RETENTION_REVOKED_KEYS_DAYS: atLeastOne.optional(),
  RETENTION_OAUTH_STATE_MINUTES: atLeastOne.optional(),
  RETENTION_ORPHAN_CONFIG_DIR_HOURS: atLeastOne.optional(),
  RETENTION_SDK_TRANSCRIPT_HOURS: atLeastOne.optional(),
  JANITOR_INTERVAL_MINUTES: atLeastOne.optional(),
  USAGE_ROLLUP_INTERVAL_MINUTES: atLeastOne.optional(),
  OAUTH_STATE_PURGE_INTERVAL_MINUTES: atLeastOne.optional(),
  QUOTA_FLOOR_INTERVAL_MINUTES: atLeastOne.optional(),
  CONFIG_DIR_REAP_INTERVAL_MINUTES: atLeastOne.optional(),
  SDK_TRANSCRIPT_SWEEP_INTERVAL_MINUTES: atLeastOne.optional(),
  // Both refuse 0: an interval of zero re-arms every millisecond, and a threshold of zero makes
  // every account idle, so the sweep would bill a request per account per tick, forever.
  IDLE_ACCOUNT_PROBE_INTERVAL_MINUTES: atLeastOne.optional(),
  IDLE_ACCOUNT_AFTER_DAYS: atLeastOne.optional(),
  IDLE_ACCOUNT_PROBE_BATCH_SIZE: atLeastOne.optional(),
  IDLE_ACCOUNT_PROBE_PAID_TURN: flag.optional(),
  ADMIN_SESSION_PURGE_INTERVAL_MINUTES: atLeastOne.optional(),
  MODEL_CATALOG_REFRESH_INTERVAL_MINUTES: atLeastOne.optional(),
  MODEL_CATALOG_REFRESH_BATCH_SIZE: atLeastOne.optional(),
  SWEEP_BATCH_SIZE: atLeastOne.optional(),
  SCHEDULER_JITTER_FRACTION: fraction.optional(),
  // Exclusive bounds: `0` would refresh in a loop and `1` would refresh at the instant of
  // expiry, so both are misconfigurations rather than extreme-but-valid settings.
  // The one field whose bounds are not the shared `fraction`'s: `0` would refresh in a loop and
  // `1` would refresh at the instant of expiry, so both ends are excluded rather than clamped.
  OAUTH_REFRESH_LEAD_FRACTION: fraction
    .refine((v) => v > 0 && v < 1, "must be between 0 and 1, exclusive")
    .optional(),
  OAUTH_REFRESH_LOCK_POOL_MAX_CONNECTIONS: atLeastOne
    .refine((value) => value <= 32, "must be at most 32")
    .optional(),
  OAUTH_REFRESH_MIN_DELAY_SECONDS: atLeastOne.optional(),
  OAUTH_REFRESH_MAX_ATTEMPTS: atLeastOne.optional(),
  ADMIN_SESSION_IDLE_MINUTES: atLeastOne.optional(),
  ADMIN_SESSION_ABSOLUTE_HOURS: atLeastOne.optional(),
  ADMIN_LOGIN_MAX_ATTEMPTS: atLeastOne.optional(),
  ADMIN_LOGIN_MAX_CONCURRENT: atLeastOne.optional(),
  ADMIN_LOGIN_MAX_TRACKED_IPS: atLeastOne.optional(),
  ADMIN_LOGIN_ATTEMPT_WINDOW_MINUTES: atLeastOne.optional(),
  ADMIN_LOGIN_LOCKOUT_MINUTES: atLeastOne.optional(),
  ADMIN_SESSION_TOUCH_INTERVAL_SECONDS: wholeNumber.optional(),
  ADMIN_SESSION_CACHE_MAX: atLeastOne.optional(),
  ADMIN_SESSION_REVALIDATE_SECONDS: atLeastOne.optional(),
  SESSION_COOKIE_INSECURE: flag.optional(),
  CATALOG_REFRESH_SECONDS: atLeastOne.optional(),
  KEY_CACHE_MAX: atLeastOne.optional(),
  KEY_CACHE_TTL_SECONDS: atLeastOne.optional(),
  KEY_CACHE_NEGATIVE_TTL_SECONDS: wholeNumber.optional(),
  SESSION_CACHE_MAX: atLeastOne.optional(),
  SESSION_CACHE_TTL_SECONDS: atLeastOne.optional(),
  SESSION_CACHE_NEGATIVE_TTL_SECONDS: wholeNumber.optional(),
  USAGE_QUEUE_MAX: atLeastOne.optional(),
  USAGE_BATCH_SIZE: usageBatchSize.optional(),
  USAGE_FLUSH_INTERVAL_MS: atLeastOne.optional(),
  // Refuses zero: an unthrottled failure flood is the incident the throttle exists to prevent.
  USAGE_LOG_REPORT_INTERVAL_MS: atLeastOne.optional(),
  QUOTA_WRITE_INTERVAL_MS: atLeastOne.optional(),
  ACCOUNT_STATUS_WRITE_INTERVAL_MS: atLeastOne.optional(),
  MAX_REQUEST_BODY_BYTES: atLeastOne.optional(),
  MAX_REQUEST_JSON_DEPTH: atLeastOne
    .refine((value) => value >= 2 && value <= 4096, "must be between 2 and 4096")
    .optional(),
  ROUTING_MAX_ATTEMPTS: atLeastOne.optional(),
  ROUTING_FAILURE_THRESHOLD: atLeastOne.optional(),
  ROUTING_BASE_BACKOFF_MS: atLeastOne.optional(),
  ROUTING_MAX_BACKOFF_MS: atLeastOne.optional(),
  ROUTING_HALF_OPEN_HOLD_MS: atLeastOne.optional(),
  // Refuses zero: a zero cooldown re-dials a refused key on every request.
  ROUTING_AUTH_FAILURE_COOLDOWN_MS: atLeastOne.optional(),
  // Refuses zero for the same reason. Below the cooldown it is not refused: the cooldown wins.
  ROUTING_AUTH_FAILURE_MAX_COOLDOWN_MS: atLeastOne.optional(),
  // Refuses zero: `Retry-After: 0` invites an immediate retry storm against accounts that are,
  // by definition, not ready.
  ROUTING_UNKNOWN_RESET_RETRY_AFTER_SECONDS: atLeastOne.optional(),
  // `fail` keeps a bound session on its cooling-down account and answers 429; `rebind` drops the
  // binding and starts the conversation fresh on another eligible account. Enum, not a number —
  // the drift guard's zero rule does not apply.
  ROUTING_BOUND_ACCOUNT_COOLING_DOWN: z.enum(["fail", "rebind"]).optional(),
  UPSTREAM_TIMEOUT_MS: atLeastOne.optional(),
  UPSTREAM_ERROR_MAX_BYTES: atLeastOne
    .refine((value) => value <= 33_554_432, "must be at most 33554432")
    .optional(),
  UPSTREAM_RESPONSE_OBSERVATION_MAX_BYTES: atLeastOne
    .refine((value) => value <= 1_048_576, "must be at most 1048576")
    .optional(),
  TRANSLATE_DEFAULT_MAX_TOKENS: atLeastOne.optional(),
  MAX_TRANSLATION_PENDING_BYTES: atLeastOne
    .refine((value) => value >= 1024 && value <= 33_554_432)
    .optional(),
} as const

export const boundedEnvSchema = z.object(ENV_FIELDS).superRefine(validateNumericBounds)
export type ParsedEnv = z.output<typeof boundedEnvSchema>
