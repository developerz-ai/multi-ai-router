import type { Dialect, OpenAiChatCeiling } from "@multi-ai-router/core"
import { anthropicToOpenAiChatRequest } from "./anthropic-to-openai-chat/request"
import { anthropicToOpenAiChatResponse } from "./anthropic-to-openai-chat/response"
import { anthropicToOpenAiChatStream } from "./anthropic-to-openai-chat/stream"
import { anthropicToOpenAiResponsesRequest } from "./anthropic-to-openai-responses/request"
import { anthropicToOpenAiResponsesResponse } from "./anthropic-to-openai-responses/response"
import { anthropicToOpenAiResponsesStream } from "./anthropic-to-openai-responses/stream"
import { openAiChatToAnthropicRequest } from "./openai-chat-to-anthropic/request"
import { openAiChatToAnthropicResponse } from "./openai-chat-to-anthropic/response"
import { openAiChatToAnthropicStream } from "./openai-chat-to-anthropic/stream"
import { openAiChatToOpenAiResponsesRequest } from "./openai-chat-to-openai-responses/request"
import { openAiChatToOpenAiResponsesResponse } from "./openai-chat-to-openai-responses/response"
import { openAiChatToOpenAiResponsesStream } from "./openai-chat-to-openai-responses/stream"
import { openAiResponsesToAnthropicRequest } from "./openai-responses-to-anthropic/request"
import { openAiResponsesToAnthropicResponse } from "./openai-responses-to-anthropic/response"
import { openAiResponsesToAnthropicStream } from "./openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatRequest } from "./openai-responses-to-openai-chat/request"
import { openAiResponsesToOpenAiChatResponse } from "./openai-responses-to-openai-chat/response"
import { openAiResponsesToOpenAiChatStream } from "./openai-responses-to-openai-chat/stream"
import type { TranslatedResponse } from "./shared/response"
import type { StreamTranslator } from "./sse/emit"

/**
 * Which conversion serves an (ingress dialect, egress dialect) pair — the lookup the egress decision
 * makes, and the only thing that has to change when a pair is added.
 *
 * **The request and the response run in opposite directions**, and mixing them up is the one way to
 * get this file wrong. A client speaking `anthropic` against an `openai-chat` account sends a body
 * that must be translated *toward* openai-chat and gets an answer that must be translated *back*
 * toward anthropic. So the entry for that pair pairs `anthropicToOpenAiChat*Request*` with
 * `openAiChatToAnthropic*Response*`, not with its same-named sibling.
 *
 * A pair with no entry is not "translate badly"; it is refused by name before any upstream call
 * (`services/dataplane/egress/mode.ts`). All six crossings between the three HTTP dialects have one
 * today; a dialect added later becomes servable by adding entries here and nothing else — the
 * Open/Closed rule the design rules state.
 *
 * The diagonal is deliberately absent. Same-dialect egress is a byte relay in the transport layer
 * with no schema knowledge at all, and giving it a translator here would invite someone to use it.
 */

export interface TranslationContext {
  /**
   * Unix **seconds**, stamped on every emitted openai-chat object.
   *
   * Supplied by the caller because a translator holds no clock: the same recorded input must
   * produce the same output in a test as it does on the wire.
   */
  readonly created: number
  /** Exactly what the client asked for. Used until the upstream names a model of its own. */
  readonly model: string
  /**
   * The id used only when the upstream never names one — the request's correlation id, prefixed
   * per dialect. Deterministic and never random, for the same reason `created` is injected.
   */
  readonly fallbackId: string
  /**
   * Anthropic requires `max_tokens` and openai-chat's is optional, so a ceiling has to come from
   * somewhere when a client omits it. The operator's configured value; see `request.ts`.
   */
  readonly defaultMaxTokens?: number | undefined
  /**
   * Which spelling of the openai-chat output ceiling the **selected Account** accepts.
   *
   * The one member of this context that varies per *candidate* rather than per request, because it
   * is a fact about the upstream rather than about what the client sent: two openai-chat accounts in
   * one pool can want different names, so a failover between them re-converts (`translate-body.ts`).
   * Absent means the default — see `OpenAiChatCeiling`.
   */
  readonly chatCeiling?: OpenAiChatCeiling | undefined
}

export interface TranslationPair {
  /** The dialect the client speaks — the ingress surface it called. */
  readonly ingress: Dialect
  /** The dialect the selected Account speaks natively. */
  readonly egress: Dialect
  /**
   * Client body → upstream body.
   *
   * @throws TranslationError (400) naming the field with no representation in `egress`. Thrown
   * before any upstream call, which is the whole point of doing it here.
   */
  readonly request: (body: unknown, context: TranslationContext) => unknown
  /** Upstream body → client body, for a response that did not stream. Never throws. */
  readonly response: (body: unknown, context: TranslationContext) => TranslatedResponse
  /** Upstream SSE → client SSE, one event in and zero or more out. Never throws. */
  readonly stream: (context: TranslationContext) => StreamTranslator
}

/** Each dialect's ids have a shape — `msg_…`, `chatcmpl-…`, `resp_…`; a fallback looks like one. */
const ANTHROPIC_ID_PREFIX = "msg_"
const OPENAI_CHAT_ID_PREFIX = "chatcmpl-"
const OPENAI_RESPONSES_ID_PREFIX = "resp_"

const ANTHROPIC_TO_OPENAI_CHAT: TranslationPair = {
  ingress: "anthropic",
  egress: "openai-chat",
  // No `defaultMaxTokens` in this direction: Anthropic requires `max_tokens` on the way in, so a
  // request that reached here already carries the ceiling the client chose. Which of openai-chat's
  // two names it is emitted under is the target account's answer.
  request: (body, context) => anthropicToOpenAiChatRequest(body, { ceiling: context.chatCeiling }),
  response: (body, context) =>
    openAiChatToAnthropicResponse(body, {
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiChatToAnthropicStream({
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const OPENAI_CHAT_TO_ANTHROPIC: TranslationPair = {
  ingress: "openai-chat",
  egress: "anthropic",
  request: (body, context) =>
    openAiChatToAnthropicRequest(body, { defaultMaxTokens: context.defaultMaxTokens }),
  response: (body, context) =>
    anthropicToOpenAiChatResponse(body, {
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    anthropicToOpenAiChatStream({
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const ANTHROPIC_TO_OPENAI_RESPONSES: TranslationPair = {
  ingress: "anthropic",
  egress: "openai-responses",
  // No `defaultMaxTokens` in this direction either: an anthropic request carries its own ceiling.
  request: (body) => anthropicToOpenAiResponsesRequest(body),
  response: (body, context) =>
    openAiResponsesToAnthropicResponse(body, {
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiResponsesToAnthropicStream({
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const OPENAI_RESPONSES_TO_ANTHROPIC: TranslationPair = {
  ingress: "openai-responses",
  egress: "anthropic",
  request: (body, context) =>
    openAiResponsesToAnthropicRequest(body, { defaultMaxTokens: context.defaultMaxTokens }),
  response: (body, context) =>
    anthropicToOpenAiResponsesResponse(body, {
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    anthropicToOpenAiResponsesStream({
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const OPENAI_CHAT_TO_OPENAI_RESPONSES: TranslationPair = {
  ingress: "openai-chat",
  egress: "openai-responses",
  request: (body) => openAiChatToOpenAiResponsesRequest(body),
  response: (body, context) =>
    openAiResponsesToOpenAiChatResponse(body, {
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiResponsesToOpenAiChatStream({
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

/** The documented **downgrade**: the richer dialect expressed in the poorer one. */
const OPENAI_RESPONSES_TO_OPENAI_CHAT: TranslationPair = {
  ingress: "openai-responses",
  egress: "openai-chat",
  request: (body, context) =>
    openAiResponsesToOpenAiChatRequest(body, { ceiling: context.chatCeiling }),
  response: (body, context) =>
    openAiChatToOpenAiResponsesResponse(body, {
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiChatToOpenAiResponsesStream({
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

/**
 * A `Map`, not an object literal: the key is built from two values that reach this module from a
 * request, and a plain object would resolve `"constructor"` through its prototype and hand the
 * caller something that is not a translation pair at all.
 */
const PAIRS: ReadonlyMap<string, TranslationPair> = new Map(
  [
    ANTHROPIC_TO_OPENAI_CHAT,
    OPENAI_CHAT_TO_ANTHROPIC,
    ANTHROPIC_TO_OPENAI_RESPONSES,
    OPENAI_RESPONSES_TO_ANTHROPIC,
    OPENAI_CHAT_TO_OPENAI_RESPONSES,
    OPENAI_RESPONSES_TO_OPENAI_CHAT,
  ].map((pair) => [key(pair.ingress, pair.egress), pair]),
)

/** @returns null when the pair is the same-dialect diagonal, or when no translator exists yet. */
export function translationPair(ingress: Dialect, egress: Dialect): TranslationPair | null {
  if (ingress === egress) return null
  return PAIRS.get(key(ingress, egress)) ?? null
}

function key(ingress: Dialect, egress: Dialect): string {
  return `${ingress}>${egress}`
}
