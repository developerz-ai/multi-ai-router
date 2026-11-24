import type { Logger } from "../../logging/logger"
import type { FetchLike } from "../../services/dataplane/types"
import type { SdkConcurrency } from "../claude-sdk/concurrency"
import type { SdkInvoker } from "../claude-sdk/invoke"
import type { FastCredential } from "./credential"

export type FastFallbackReason = "credential" | "model" | "profile"

export interface FastInvokerDeps {
  readonly concurrency: SdkConcurrency
  readonly sdk: SdkInvoker
  /** Must read under this Account's existing metadata-owner fence (or its stat-keyed cache). */
  readonly credential: (accountId: string, configDir: string) => Promise<FastCredential | null>
  /** Drops a cached credential after Anthropic answered `401`/`403` (`credential-cache.ts`). */
  readonly forgetCredential?: (accountId: string) => void
  readonly resolveModel: (accountId: string, model: string) => string | null
  readonly errorMaxBytes: number
  /**
   * How long a native structured-output request may wait for Anthropic's response headers
   * (`CLAUDE_FAST_NATIVE_SCHEMA_TIMEOUT_SECONDS`). Anthropic compiles the schema before it answers
   * and held prod clients ~180 s for a `Schema is too complex.` 400 (101 finding 10.4); past this
   * bound the attempt is abandoned and re-sent on the adapted tool, which needs no compile.
   */
  readonly nativeSchemaTimeoutMs?: number
  /** Schemas remembered as refused natively, so a repeat skips the wait (bounded, oldest out). */
  readonly nativeSchemaMemoSize?: number
  readonly fetch?: FetchLike
  readonly now?: () => number
  /**
   * The `translation dropped fields` warn window (`TRANSLATION_DROP_LOG_WINDOW_SECONDS`), shared
   * with the translator's own line: one warn per key and drop signature per window, then `debug`.
   */
  readonly dropLogWindowMs?: number
  /** Every fallback, for the `claude_fast_fallback_total{reason}` counter. */
  readonly onFallback?: (reason: FastFallbackReason, accountId: string) => void
  /** Warn-once per Account and reason for fallbacks; the transport and native-schema reasons. */
  readonly logger?: Logger
}
