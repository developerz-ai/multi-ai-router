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
 * with itself. The same argument makes the *emitted* event sequence shared per target dialect
 * (`shared/anthropic-stream.ts`, `shared/responses-stream.ts`): the order a dialect's clients rely
 * on is a fact about that dialect, and two copies of it could disagree — which would let a client
 * tell from the stream which ingress path served it, the one thing a translator exists to hide.
 * openai-chat has no such module on purpose: its stream carries no block or item structure at all,
 * so there is no ordering two writers of it could disagree about.
 */

export type { AnthropicToOpenAiChatOptions } from "./anthropic-to-openai-chat/request"
export { anthropicToOpenAiChatRequest } from "./anthropic-to-openai-chat/request"
export type { AnthropicToOpenAiChatResponseOptions } from "./anthropic-to-openai-chat/response"
export { anthropicToOpenAiChatResponse } from "./anthropic-to-openai-chat/response"
export type { AnthropicToOpenAiChatStreamOptions } from "./anthropic-to-openai-chat/stream"
export { anthropicToOpenAiChatStream } from "./anthropic-to-openai-chat/stream"
export type { AnthropicToOpenAiResponsesOptions } from "./anthropic-to-openai-responses/request"
export { anthropicToOpenAiResponsesRequest } from "./anthropic-to-openai-responses/request"
export type { AnthropicToOpenAiResponsesResponseOptions } from "./anthropic-to-openai-responses/response"
export { anthropicToOpenAiResponsesResponse } from "./anthropic-to-openai-responses/response"
export type { AnthropicToOpenAiResponsesStreamOptions } from "./anthropic-to-openai-responses/stream"
export { anthropicToOpenAiResponsesStream } from "./anthropic-to-openai-responses/stream"
export type { OpenAiChatToAnthropicOptions } from "./openai-chat-to-anthropic/request"
export { openAiChatToAnthropicRequest } from "./openai-chat-to-anthropic/request"
export type { OpenAiChatToAnthropicResponseOptions } from "./openai-chat-to-anthropic/response"
export { openAiChatToAnthropicResponse } from "./openai-chat-to-anthropic/response"
export type { OpenAiChatToAnthropicStreamOptions } from "./openai-chat-to-anthropic/stream"
export { openAiChatToAnthropicStream } from "./openai-chat-to-anthropic/stream"
export { openAiChatToOpenAiResponsesRequest } from "./openai-chat-to-openai-responses/request"
export type { OpenAiChatToOpenAiResponsesResponseOptions } from "./openai-chat-to-openai-responses/response"
export { openAiChatToOpenAiResponsesResponse } from "./openai-chat-to-openai-responses/response"
export type { OpenAiChatToOpenAiResponsesStreamOptions } from "./openai-chat-to-openai-responses/stream"
export { openAiChatToOpenAiResponsesStream } from "./openai-chat-to-openai-responses/stream"
export type { OpenAiResponsesToAnthropicOptions } from "./openai-responses-to-anthropic/request"
export { openAiResponsesToAnthropicRequest } from "./openai-responses-to-anthropic/request"
export type { OpenAiResponsesToAnthropicResponseOptions } from "./openai-responses-to-anthropic/response"
export { openAiResponsesToAnthropicResponse } from "./openai-responses-to-anthropic/response"
export type { OpenAiResponsesToAnthropicStreamOptions } from "./openai-responses-to-anthropic/stream"
export { openAiResponsesToAnthropicStream } from "./openai-responses-to-anthropic/stream"
export { openAiResponsesToOpenAiChatRequest } from "./openai-responses-to-openai-chat/request"
export type { OpenAiResponsesToOpenAiChatResponseOptions } from "./openai-responses-to-openai-chat/response"
export { openAiResponsesToOpenAiChatResponse } from "./openai-responses-to-openai-chat/response"
export type { OpenAiResponsesToOpenAiChatStreamOptions } from "./openai-responses-to-openai-chat/stream"
export { openAiResponsesToOpenAiChatStream } from "./openai-responses-to-openai-chat/stream"
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
export { DEFAULT_MAX_TOKENS } from "./shared/anthropic"
export type { DropSink, TranslationDrop } from "./shared/drops"
export { IGNORE_DROPS } from "./shared/drops"
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
export type {
  OpenAiResponsesItem,
  OpenAiResponsesPart,
  OpenAiResponsesRequest,
  OpenAiResponsesTool,
  OpenAiResponsesToolChoice,
} from "./shared/openai-responses"
export {
  assertNoStopSequence,
  assertPlainResponseFormat,
  assertPlainTextFormat,
  assertStatelessResponses,
  assertTranslatableToAnthropic,
  parseRequest,
  rejectField,
  rejectStatefulItem,
} from "./shared/reject"
export type { TranslatedResponse } from "./shared/response"
export type { ReadResponsesBody, ReadResponsesItem } from "./shared/responses-read"
export { readResponsesBody } from "./shared/responses-read"
export type {
  AnthropicStopReason,
  MappedReason,
  OpenAiFinishReason,
  ResponsesCompletion,
} from "./shared/stop-reason"
export {
  ANTHROPIC_STOP_REASONS,
  CONSERVATIVE_FINISH_REASON,
  CONSERVATIVE_STOP_REASON,
  fromResponsesCompletion,
  isAnthropicStopReason,
  isOpenAiFinishReason,
  OPENAI_FINISH_REASONS,
  readOpenAiFinishReason,
  toAnthropicStopReason,
  toOpenAiFinishReason,
  toResponsesCompletion,
} from "./shared/stop-reason"
export { toolChoiceForOpenAiChat } from "./shared/tool-choice"
export {
  argumentsFromInput,
  inputFromArguments,
  toolChoiceFromOpenAiResponses,
  toolChoiceToAnthropic,
  toolChoiceToOpenAiChat,
  toolChoiceToOpenAiResponses,
  toolsFromOpenAiResponses,
  toolsToAnthropic,
  toolsToOpenAiChat,
  toolsToOpenAiResponses,
} from "./shared/tools"
export type { AnthropicUsage, OpenAiChatUsage, OpenAiResponsesUsage } from "./shared/usage"
export {
  anthropicUsageCounts,
  openAiChatUsageToResponses,
  parseAnthropicUsage,
  parseOpenAiChatUsage,
  parseOpenAiResponsesUsage,
  responsesUsageToOpenAiChat,
  usageToAnthropic,
  usageToOpenAiChat,
} from "./shared/usage"
export type { SseEvent, StreamTranslator } from "./sse/emit"
export { DONE, encodeSseEvent, NO_EVENTS } from "./sse/emit"
export type { SseFrame, SseParser, SseParserOptions } from "./sse/parse"
export { createSseParser, frameJson } from "./sse/parse"
