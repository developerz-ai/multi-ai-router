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
 */

export { anthropicToOpenAiChatRequest } from "./anthropic-to-openai-chat/request"
export type { OpenAiChatToAnthropicOptions } from "./openai-chat-to-anthropic/request"
export {
  DEFAULT_MAX_TOKENS,
  openAiChatToAnthropicRequest,
} from "./openai-chat-to-anthropic/request"
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
export {
  argumentsFromInput,
  inputFromArguments,
  toolChoiceToAnthropic,
  toolChoiceToOpenAiChat,
  toolsToAnthropic,
  toolsToOpenAiChat,
} from "./shared/tools"
