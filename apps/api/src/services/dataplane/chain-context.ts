import type { Logger } from "../../logging/logger"
import type { ModelCatalogStore } from "../models/store"
import type { FailoverOptions } from "../routing"
import type { TranslationContext } from "../translate"
import type { ByteSpan } from "./body/scanner"
import type { ServableCandidate } from "./plan"
import type { DispatchRuntime } from "./runtime"
import type { TranslatedRequestBody } from "./translate-body"

/** Everything one failover chain reads (`chain.ts`). */
export interface ChainContext {
  readonly modelMetadata?: Pick<ModelCatalogStore, "describe"> | undefined

  readonly runtime: DispatchRuntime
  readonly plan: readonly ServableCandidate[]
  /** The client's request: method, headers, and abort signal are taken from it. */
  readonly request: Request
  readonly bodyBytes: Uint8Array
  readonly modelSpan: ByteSpan | null
  /** The client's top-level `stream: true`, from the routing scan (`body/scanner.ts`). */
  readonly streamRequested?: boolean
  /** The clock stamp, fallback ids, and configured ceiling every conversion of this request reads. */
  readonly translation: TranslationContext
  /** The converted upstream body, built lazily and only for a candidate that needs one. */
  readonly translated: TranslatedRequestBody
  readonly failover: FailoverOptions | undefined
  /**
   * Selection already refused this session's binding (`rebind` on a cooling account, out of scope,
   * exhausted, gone) — the reason, for the restart header a turn that could not carry the session
   * answers with (`session-restart.ts`).
   */
  readonly bindingRefused?: string
  readonly log: Logger | undefined
  /**
   * Ceiling on the upstream's own words quoted on a failed-attempt log line — `LOG_REASON_MAX_CHARS`,
   * threaded through `DispatchOptions.log`. Absent means {@link DEFAULT_LOG_REASON_MAX_CHARS}.
   */
  readonly reasonMaxChars?: number
}
