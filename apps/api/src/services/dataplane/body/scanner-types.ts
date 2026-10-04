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
  conversationPrefix: Uint8Array
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
  push(chunk: Uint8Array): void
  readonly done: boolean
  result(): ScanResult
  finish(): ScanResult
}
