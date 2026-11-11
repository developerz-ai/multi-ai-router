import type { Dialect } from "@multi-ai-router/core"
import { anthropicToOpenAiChatRequestFromParsed } from "./anthropic-to-openai-chat/request"
import { anthropicToOpenAiChatResponse } from "./anthropic-to-openai-chat/response"
import { anthropicToOpenAiChatStream } from "./anthropic-to-openai-chat/stream"
import { anthropicToOpenAiResponsesRequestFromParsed } from "./anthropic-to-openai-responses/request"
import { anthropicToOpenAiResponsesResponse } from "./anthropic-to-openai-responses/response"
import { anthropicToOpenAiResponsesStream } from "./anthropic-to-openai-responses/stream"
import { openAiChatToAnthropicRequestFromParsed } from "./openai-chat-to-anthropic/request"
import { openAiChatToAnthropicResponse } from "./openai-chat-to-anthropic/response"
import { openAiChatToAnthropicStream } from "./openai-chat-to-anthropic/stream"
import { openAiChatToOpenAiResponsesRequestFromParsed } from "./openai-chat-to-openai-responses/request"
import { openAiChatToOpenAiResponsesResponse } from "./openai-chat-to-openai-responses/response"
import { openAiChatToOpenAiResponsesStream } from "./openai-chat-to-openai-responses/stream"
import { openAiResponsesToAnthropicRequestFromParsed } from "./openai-responses-to-anthropic/request"
import { openAiResponsesToAnthropicResponse } from "./openai-responses-to-anthropic/response"
import { openAiResponsesToAnthropicStream } from "./openai-responses-to-anthropic/stream"
import { openAiResponsesToOpenAiChatRequestFromParsed } from "./openai-responses-to-openai-chat/request"
import { openAiResponsesToOpenAiChatResponse } from "./openai-responses-to-openai-chat/response"
import { openAiResponsesToOpenAiChatStream } from "./openai-responses-to-openai-chat/stream"
import { ingressRequest, parseIngressRequest } from "./parse-ingress"
import { translatedResponseError } from "./shared/response-error"
import { applyResponsesEgressRules } from "./shared/responses-egress"
import type { TranslationContext, TranslationPair } from "./translation-pair"

/** A pair as written below; `request` (parse, then convert) is derived for every pair at once. */
type PairDefinition = Omit<TranslationPair, "request" | "requestFromParsed"> & {
  readonly requestFromParsed: NonNullable<TranslationPair["requestFromParsed"]>
}

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

export type { TranslationContext, TranslationPair } from "./translation-pair"

/** Each dialect's ids have a shape — `msg_…`, `chatcmpl-…`, `resp_…`; a fallback looks like one. */
const ANTHROPIC_ID_PREFIX = "msg_"
const OPENAI_CHAT_ID_PREFIX = "chatcmpl-"
const OPENAI_RESPONSES_ID_PREFIX = "resp_"

const ANTHROPIC_TO_OPENAI_CHAT: PairDefinition = {
  ingress: "anthropic",
  egress: "openai-chat",
  // No `defaultMaxTokens` in this direction: Anthropic requires `max_tokens` on the way in, so a
  // request that reached here already carries the ceiling the client chose. Which of openai-chat's
  // two names it is emitted under is the target account's answer.
  requestFromParsed: (parsed, context) =>
    anthropicToOpenAiChatRequestFromParsed(ingressRequest(parsed, "anthropic"), {
      ceiling: context.chatCeiling,
      onDrop: context.onDrop,
      cacheControl: context.cacheControl,
    }),
  response: (body, context) =>
    openAiChatToAnthropicResponse(body, {
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiChatToAnthropicStream({
      maximumPendingBytes: context.maximumPendingBytes,
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const OPENAI_CHAT_TO_ANTHROPIC: PairDefinition = {
  ingress: "openai-chat",
  egress: "anthropic",
  requestFromParsed: (parsed, context) =>
    openAiChatToAnthropicRequestFromParsed(ingressRequest(parsed, "openai-chat"), {
      defaultMaxTokens: context.defaultMaxTokens,
      onDrop: context.onDrop,
      automaticCache: context.cacheControl,
    }),
  response: (body, context) =>
    anthropicToOpenAiChatResponse(body, {
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    anthropicToOpenAiChatStream({
      includeUsage: context.includeUsage,
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

/** Anthropic requires `max_tokens`, so every body this pair writes carries `max_output_tokens`. */
const ANTHROPIC_CEILING: ReadonlySet<string> = new Set(["max_output_tokens"])

const ANTHROPIC_TO_OPENAI_RESPONSES: PairDefinition = {
  ingress: "anthropic",
  egress: "openai-responses",
  // No `defaultMaxTokens` in this direction either: an anthropic request carries its own ceiling.
  requestFromParsed: (parsed, context) =>
    applyResponsesEgressRules(
      anthropicToOpenAiResponsesRequestFromParsed(ingressRequest(parsed, "anthropic"), context),
      context.responsesEgress,
      context.onDrop,
      ANTHROPIC_CEILING,
    ),
  response: (body, context) =>
    openAiResponsesToAnthropicResponse(body, {
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
      reasoningSeal: context.reasoningSeal,
    }),
  stream: (context) =>
    openAiResponsesToAnthropicStream({
      maximumPendingBytes: context.maximumPendingBytes,
      id: `${ANTHROPIC_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
      reasoningSeal: context.reasoningSeal,
    }),
}

const OPENAI_RESPONSES_TO_ANTHROPIC: PairDefinition = {
  ingress: "openai-responses",
  egress: "anthropic",
  requestFromParsed: (parsed, context) =>
    openAiResponsesToAnthropicRequestFromParsed(ingressRequest(parsed, "openai-responses"), {
      defaultMaxTokens: context.defaultMaxTokens,
      onDrop: context.onDrop,
      automaticCache: context.cacheControl,
    }),
  response: (body, context) =>
    anthropicToOpenAiResponsesResponse(body, {
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    anthropicToOpenAiResponsesStream({
      maximumPendingBytes: context.maximumPendingBytes,
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

const OPENAI_CHAT_TO_OPENAI_RESPONSES: PairDefinition = {
  ingress: "openai-chat",
  egress: "openai-responses",
  requestFromParsed: (parsed, context) =>
    applyResponsesEgressRules(
      openAiChatToOpenAiResponsesRequestFromParsed(ingressRequest(parsed, "openai-chat")),
      context.responsesEgress,
      context.onDrop,
    ),
  response: (body, context) =>
    openAiResponsesToOpenAiChatResponse(body, {
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiResponsesToOpenAiChatStream({
      maximumPendingBytes: context.maximumPendingBytes,
      includeUsage: context.includeUsage,
      created: context.created,
      id: `${OPENAI_CHAT_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
}

/** The documented **downgrade**: the richer dialect expressed in the poorer one. */
const OPENAI_RESPONSES_TO_OPENAI_CHAT: PairDefinition = {
  ingress: "openai-responses",
  egress: "openai-chat",
  requestFromParsed: (parsed, context) =>
    openAiResponsesToOpenAiChatRequestFromParsed(ingressRequest(parsed, "openai-responses"), {
      ceiling: context.chatCeiling,
      onDrop: context.onDrop,
    }),
  response: (body, context) =>
    openAiChatToOpenAiResponsesResponse(body, {
      created: context.created,
      id: `${OPENAI_RESPONSES_ID_PREFIX}${context.fallbackId}`,
      model: context.model,
    }),
  stream: (context) =>
    openAiChatToOpenAiResponsesStream({
      maximumPendingBytes: context.maximumPendingBytes,
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
  ].map((pair) => [
    key(pair.ingress, pair.egress),
    {
      ...pair,
      request: (body: unknown, context: TranslationContext) =>
        pair.requestFromParsed(parseIngressRequest(pair.ingress, body), context),
      response: (body: unknown, context: TranslationContext) =>
        translatedResponseError(body, pair.ingress, pair.egress) ?? pair.response(body, context),
    },
  ]),
)

/** @returns null when the pair is the same-dialect diagonal, or when no translator exists yet. */
export function translationPair(ingress: Dialect, egress: Dialect): TranslationPair | null {
  if (ingress === egress) return null
  return PAIRS.get(key(ingress, egress)) ?? null
}

function key(ingress: Dialect, egress: Dialect): string {
  return `${ingress}>${egress}`
}
