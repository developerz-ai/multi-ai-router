import type { Dialect } from "@multi-ai-router/core"
import { anthropicRequestSchema, type ParsedAnthropicRequest } from "./shared/anthropic"
import { openAiChatRequestSchema, type ParsedOpenAiChatRequest } from "./shared/openai-chat"
import {
  openAiResponsesRequestSchema,
  type ParsedOpenAiResponsesRequest,
} from "./shared/openai-responses"
import { parseRequest } from "./shared/reject"

/**
 * A client body validated once into its ingress dialect's parsed shape.
 *
 * The parse is the bulk of a request translation's cost (Zod over every block of a long
 * transcript), and it depends only on the body — never on the target account. So the caller parses
 * once per request and every candidate's conversion starts from the same value
 * (`dataplane/translate-body.ts`); translators read it and never mutate it. A malformed body is a
 * `400` naming its deepest field, exactly as the one-shot `*Request(body)` entry points throw.
 */
export type ParsedIngressRequest =
  | { readonly dialect: "anthropic"; readonly request: ParsedAnthropicRequest }
  | { readonly dialect: "openai-chat"; readonly request: ParsedOpenAiChatRequest }
  | { readonly dialect: "openai-responses"; readonly request: ParsedOpenAiResponsesRequest }

interface IngressRequests {
  readonly anthropic: ParsedAnthropicRequest
  readonly "openai-chat": ParsedOpenAiChatRequest
  readonly "openai-responses": ParsedOpenAiResponsesRequest
}

export type { ParsedAnthropicRequest, ParsedOpenAiChatRequest, ParsedOpenAiResponsesRequest }

export function parseAnthropicRequest(body: unknown): ParsedAnthropicRequest {
  return parseRequest(anthropicRequestSchema, body, "anthropic")
}

export function parseOpenAiChatRequest(body: unknown): ParsedOpenAiChatRequest {
  return parseRequest(openAiChatRequestSchema, body, "openai-chat")
}

export function parseOpenAiResponsesRequest(body: unknown): ParsedOpenAiResponsesRequest {
  return parseRequest(openAiResponsesRequestSchema, body, "openai-responses")
}

/** @throws TranslationError (400) naming the deepest malformed field. */
export function parseIngressRequest(dialect: Dialect, body: unknown): ParsedIngressRequest {
  switch (dialect) {
    case "anthropic":
      return { dialect, request: parseAnthropicRequest(body) }
    case "openai-chat":
      return { dialect, request: parseOpenAiChatRequest(body) }
    case "openai-responses":
      return { dialect, request: parseOpenAiResponsesRequest(body) }
  }
}

/**
 * The parsed request a pair of this ingress reads. A mismatch is the caller handing one dialect's
 * parse to another dialect's pair — a programming error, never a client's.
 */
export function ingressRequest<D extends Dialect>(
  parsed: ParsedIngressRequest,
  dialect: D,
): IngressRequests[D] {
  if (parsed.dialect !== dialect) {
    throw new TypeError(`a ${parsed.dialect} parse was handed to a ${dialect} translation pair`)
  }
  // Narrowed by the check above: the tag names which parsed shape `request` is.
  return parsed.request as IngressRequests[D]
}
