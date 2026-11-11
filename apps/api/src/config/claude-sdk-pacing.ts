import type { z } from "zod"
import { atLeastOne } from "./fields"

/**
 * The Agent-SDK path's stream pacing, deny hold and login / auth-status deadlines, as
 * configuration (CLAUDE.md non-negotiable 11). Defaults are the constants the claude-sdk provider
 * shipped with (`render/idle-guard.ts` `DEFAULT_STREAM_PACING`, `tools/early-stop.ts`,
 * `login/spawn.ts`, `login/status.ts`, the SDK invoker's teardown and the fast invoker's native-schema
 * bounds), so an unset variable changes nothing.
 *
 * Every one refuses zero: a zero idle bound or heartbeat disables the guard that keeps a quiet
 * stream honest, and a zero deadline fails every login before the CLI has printed a URL.
 */
export const CLAUDE_SDK_PACING_ENV_FIELDS = {
  CLAUDE_SDK_STREAM_IDLE_SECONDS: atLeastOne.optional(),
  CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS: atLeastOne.optional(),
  CLAUDE_SDK_DENY_HOLD_SECONDS: atLeastOne.optional(),
  CLAUDE_LOGIN_URL_TIMEOUT_SECONDS: atLeastOne.optional(),
  CLAUDE_LOGIN_EXCHANGE_TIMEOUT_SECONDS: atLeastOne.optional(),
  CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS: atLeastOne.optional(),
  CLAUDE_SDK_TEARDOWN_TIMEOUT_MS: atLeastOne.optional(),
  CLAUDE_FAST_NATIVE_SCHEMA_TIMEOUT_SECONDS: atLeastOne.optional(),
  CLAUDE_FAST_NATIVE_SCHEMA_MEMO_SIZE: atLeastOne.optional(),
}

export interface ClaudeSdkPacingConfig {
  /** A stream with no SDK event for this long fails `504` instead of hanging. */
  readonly streamIdleMs: number
  /** The `: ping` cadence on a quiet SDK stream; must sit inside the listener's idle clock. */
  readonly streamHeartbeatMs: number
  /** How long a denied host-tool call is held before the turn is ended. */
  readonly denyHoldMs: number
  /** Deadline for `claude` to print the authorize URL. */
  readonly loginUrlTimeoutMs: number
  /** Deadline for the pasted code's token exchange. */
  readonly loginExchangeTimeoutMs: number
  /** Deadline for `claude auth status`. */
  readonly authStatusTimeoutMs: number
  /** How long an ended SDK turn's subprocess teardown may take before it is abandoned. */
  readonly teardownMs: number
  /** How long a fast-mode native structured-output request waits for response headers. */
  readonly fastNativeSchemaTimeoutMs: number
  /** Schemas remembered as refused natively, so a repeat skips the wait. */
  readonly fastNativeSchemaMemoSize: number
}

type PacingEnv = { readonly [K in keyof typeof CLAUDE_SDK_PACING_ENV_FIELDS]?: number }

export function readClaudeSdkPacingEnv(
  raw: PacingEnv & { readonly serverIdleTimeoutSeconds: number },
  ctx: z.RefinementCtx,
): { readonly claudeSdkPacing: ClaudeSdkPacingConfig } | undefined {
  const heartbeatSeconds = raw.CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS ?? 15
  // Zero turns the listener's idle clock off, so there is nothing for the heartbeat to beat.
  if (raw.serverIdleTimeoutSeconds > 0 && heartbeatSeconds >= raw.serverIdleTimeoutSeconds) {
    ctx.addIssue({
      code: "custom",
      path: ["CLAUDE_SDK_STREAM_HEARTBEAT_SECONDS"],
      message:
        `must be less than SERVER_IDLE_TIMEOUT_SECONDS (${raw.serverIdleTimeoutSeconds}): the ` +
        `listener closes a quiet SDK stream before its keep-alive can fire otherwise`,
    })
    return undefined
  }
  return {
    claudeSdkPacing: {
      streamIdleMs: (raw.CLAUDE_SDK_STREAM_IDLE_SECONDS ?? 90) * 1_000,
      streamHeartbeatMs: heartbeatSeconds * 1_000,
      denyHoldMs: (raw.CLAUDE_SDK_DENY_HOLD_SECONDS ?? 60) * 1_000,
      loginUrlTimeoutMs: (raw.CLAUDE_LOGIN_URL_TIMEOUT_SECONDS ?? 30) * 1_000,
      loginExchangeTimeoutMs: (raw.CLAUDE_LOGIN_EXCHANGE_TIMEOUT_SECONDS ?? 60) * 1_000,
      authStatusTimeoutMs: (raw.CLAUDE_AUTH_STATUS_TIMEOUT_SECONDS ?? 15) * 1_000,
      teardownMs: raw.CLAUDE_SDK_TEARDOWN_TIMEOUT_MS ?? 30_000,
      fastNativeSchemaTimeoutMs: (raw.CLAUDE_FAST_NATIVE_SCHEMA_TIMEOUT_SECONDS ?? 20) * 1_000,
      fastNativeSchemaMemoSize: raw.CLAUDE_FAST_NATIVE_SCHEMA_MEMO_SIZE ?? 512,
    },
  }
}
