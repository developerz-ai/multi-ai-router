/**
 * Cross-dialect translation. Callers import from here; nothing outside this directory reaches into
 * a module inside it.
 *
 * One module per dialect pair, request and stream translators split, each direction written and
 * tested on its own — a round trip is not assumed to be lossless and is never asserted
 * (docs/idea/06-protocol-translation.md#design-rules). Every export is a **pure function**: a body
 * in, a body out, with no clock, store, network, or logger anywhere behind it.
 *
 * Passthrough is deliberately absent. Same-dialect egress is a byte relay in the transport layer,
 * not a translator, and it has no schema knowledge at all.
 *
 * The response-side helpers — stop reasons, usage, upstream errors — are shared rather than
 * per-direction: each is one small table read both ways, and splitting them per pair would make the
 * two halves of one mapping editable independently, which is how a table drifts out of agreement
 * with itself.
 */

export { anthropicToOpenAiChatRequest } from "./anthropic-to-openai-chat/request"
export type { AnthropicToOpenAiChatResponseOptions } from "./anthropic-to-openai-chat/response"
export { anthropicToOpenAiChatResponse } from "./anthropic-to-openai-chat/response"
export type { AnthropicToOpenAiChatStreamOptions } from "./anthropic-to-openai-chat/stream"
export { anthropicToOpenAiChatStream } from "./anthropic-to-openai-chat/stream"
export type { OpenAiChatToAnthropicOptions } from "./openai-chat-to-anthropic/request"
export {
  DEFAULT_MAX_TOKENS,
  openAiChatToAnthropicRequest,
} from "./openai-chat-to-anthropic/request"
export type { OpenAiChatToAnthropicResponseOptions } from "./openai-chat-to-anthropic/response"
export { openAiChatToAnthropicResponse } from "./openai-chat-to-anthropic/response"
export type { OpenAiChatToAnthropicStreamOptions } from "./openai-chat-to-anthropic/stream"
export { openAiChatToAnthropicStream } from "./openai-chat-to-anthropic/stream"
export type { TranslationContext, TranslationPair } from "./registry"
export { translationPair } from "./registry"
export type {
  AnthropicBlock,
  AnthropicImageBlock,
  AnthropicMessage,
  AnthropicRequest,
  AnthropicTextBlock,
  AnthropicTool,
  AnthropicToolChoice,
  AnthropicToolResultBlock,
  AnthropicToolUseBlock,
} from "./shared/anthropic"
export type { UpstreamErrorDetail } from "./shared/errors"
export { parseUpstreamError, translateUpstreamError } from "./shared/errors"
export type {
  OpenAiChatImagePart,
  OpenAiChatMessage,
  OpenAiChatPart,
  OpenAiChatRequest,
  OpenAiChatRole,
  OpenAiChatTextPart,
  OpenAiChatTool,
  OpenAiChatToolCall,
  OpenAiChatToolChoice,
} from "./shared/openai-chat"
export {
  assertTranslatableToAnthropic,
  parseRequest,
  rejectField,
} from "./shared/reject"
export type { TranslatedResponse } from "./shared/response"
export type {
  AnthropicStopReason,
  MappedReason,
  OpenAiFinishReason,
} from "./shared/stop-reason"
export {
  ANTHROPIC_STOP_REASONS,
  CONSERVATIVE_FINISH_REASON,
  CONSERVATIVE_STOP_REASON,
  isAnthropicStopReason,
  isOpenAiFinishReason,
  OPENAI_FINISH_REASONS,
  toAnthropicStopReason,
  toOpenAiFinishReason,
} from "./shared/stop-reason"
export {
  argumentsFromInput,
  inputFromArguments,
  toolChoiceToAnthropic,
  toolChoiceToOpenAiChat,
  toolsToAnthropic,
  toolsToOpenAiChat,
} from "./shared/tools"
export type { AnthropicUsage, OpenAiChatUsage } from "./shared/usage"
export {
  anthropicUsageCounts,
  parseAnthropicUsage,
  parseOpenAiChatUsage,
  usageToAnthropic,
  usageToOpenAiChat,
} from "./shared/usage"
export type { SseEvent, StreamTranslator } from "./sse/emit"
export { DONE, encodeSseEvent, NO_EVENTS } from "./sse/emit"
export type { SseFrame, SseParser } from "./sse/parse"
export { createSseParser, frameJson } from "./sse/parse"
