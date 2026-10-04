import { toEnvValidationError } from "./env-error"
import { readParsedEnv } from "./env-reader"
import { boundedEnvSchema } from "./env-schema"
import type { Env } from "./env-types"

export type { AdminAuthConfig, AdminOidcConfig } from "./env-admin-types"
export {
  DEFAULT_LOG_QUIET_PATHS,
  DEFAULT_SERVER_IDLE_TIMEOUT_SECONDS,
  LOG_LEVELS,
  type LogLevel,
} from "./env-defaults"
export { EnvValidationError } from "./env-error"
export type { DataPlaneConfig, FailoverConfig, TranslationConfig } from "./env-routing-types"
export type { OAuthRefreshConfig, SchedulerConfig } from "./env-scheduler-types"
export { ENV_FIELDS } from "./env-schema"
export type { DatabasePoolConfig, RetentionConfig } from "./env-storage-types"
export type { Env } from "./env-types"
export { decodeEncryptionKey, ZERO_IS_LEGAL } from "./fields"

const envSchema = boundedEnvSchema.transform(readParsedEnv)

/**
 * Validates a raw environment map into `Env`.
 *
 * @throws EnvValidationError naming every offending variable.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(compact(raw))
  if (result.success) return result.data
  throw toEnvValidationError(result.error)
}

/** An unset variable and one set to the empty string mean the same thing to an operator. */
function compact(raw: Record<string, string | undefined>): Record<string, string> {
  const compacted: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    const trimmed = value.trim()
    if (trimmed.length > 0) compacted[name] = trimmed
  }
  return compacted
}
