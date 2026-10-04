export type Frame = {
  kind: "object" | "array"
  state: "key" | "colon" | "value" | "comma" | "first"
  key: string | null
  conversation: boolean
  item: boolean
  empty: boolean
  input: boolean
}
export const MODEL_NAME_MAX_BYTES = 256
export const DEFAULT_CONVERSATION_PREFIX_BYTES = 1024
export interface ScanResult {
  model: string | null
  modelSpan: { start: number; end: number } | null
  modelTooLong: boolean
  /** Bounded bytes of a complete usable opening; empty until that opening closes. */
  conversationPrefix: Uint8Array
  /** Observed error; false on a result() snapshot does not establish EOF validity. */
  invalid: boolean
  duplicateModel: boolean
  depthExceeded: boolean
}

export interface ByteSpan {
  readonly start: number
  readonly end: number
}
export interface ScannerOptions {
  readonly conversationPrefixBytes?: number
  readonly maximumJsonDepth?: number
}
export interface RoutingScanner {
  /** Supply every body chunk before calling finish(). */
  push(chunk: Uint8Array): void
  /** EOF was explicitly finalized, whether valid or invalid. Never true merely after capture. */
  readonly done: boolean
  /** Current capture/error snapshot; complete user openings may precede document EOF. */
  result(): ScanResult
  /** Finalize at EOF: incomplete grammar and split strings/codepoints become invalid. */
  finish(): ScanResult
}
