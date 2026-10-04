import type { ScannerOptions } from "./scanner-types"
export const MAX_CONVERSATION_PREFIX_BYTES = 65536
export function validateScannerOptions(options: ScannerOptions) {
  const prefixLimit = options.conversationPrefixBytes ?? 1024,
    maximumJsonDepth = options.maximumJsonDepth ?? 256
  if (
    !Number.isInteger(prefixLimit) ||
    prefixLimit < 1 ||
    prefixLimit > MAX_CONVERSATION_PREFIX_BYTES
  )
    throw new RangeError("conversationPrefixBytes must be an integer in 1..65536")
  if (!Number.isInteger(maximumJsonDepth) || maximumJsonDepth < 2 || maximumJsonDepth > 4096)
    throw new RangeError("maximumJsonDepth must be an integer in 2..4096")
  return { prefixLimit, maximumJsonDepth }
}
