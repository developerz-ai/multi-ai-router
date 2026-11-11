import type { Dialect, OpenAiChatCeiling } from "@multi-ai-router/core"
import type { ReasoningSeal } from "../crypto/reasoning-seal"
import type { ParsedIngressRequest } from "./parse-ingress"
import type { DropSink } from "./shared/drops"
import type { TranslatedResponse } from "./shared/response"
import type { ResponsesEgressRules } from "./shared/responses-egress"
import type { ThinkingDefaultMatcher } from "./shared/thinking-default"
import type { StreamTranslator } from "./sse/emit"

/** What a translation pair is, and what the caller hands it; the pairs live in `registry.ts`. */

export interface TranslationContext {
  /**
   * Unix **seconds**, stamped on every emitted openai-chat object.
   *
   * Supplied by the caller because a translator holds no clock: the same recorded input must
   * produce the same output in a test as it does on the wire.
   */
  readonly created: number
  readonly includeUsage?: boolean | undefined
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
  readonly maximumPendingBytes?: number | undefined
  /**
   * Which spelling of the openai-chat output ceiling the **selected Account** accepts.
   *
   * The one member of this context that varies per *candidate* rather than per request, because it
   * is a fact about the upstream rather than about what the client sent: two openai-chat accounts in
   * one pool can want different names, so a failover between them re-converts (`translate-body.ts`).
   * Absent means the default — see `OpenAiChatCeiling`.
   */
  readonly chatCeiling?: OpenAiChatCeiling | undefined
  /**
   * What the **selected Account's** Responses surface demands of a body written for it — per
   * candidate for the same reason as `chatCeiling`. Absent means an ordinary Responses upstream.
   */
  readonly responsesEgress?: ResponsesEgressRules | undefined
  /**
   * Matches an upstream (post-alias) model id against the operator's think-by-default set
   * (`OPENAI_CHAT_THINKING_DEFAULT_MODELS`). A matched model that is forced to call a tool on
   * openai-chat egress gets `enable_thinking: false` emitted beside the force
   * (`shared/thinking-default.ts`), applied where the per-attempt model is reapplied
   * (`dataplane/translate-body.ts`). Absent, or matching nothing, means the dial is never emitted.
   * Request-level config, so unlike `chatCeiling` it does not vary per candidate.
   */
  readonly thinkingDefaultModels?: ThinkingDefaultMatcher | undefined
  /**
   * Where a request translator reports a field it dropped by name (`shared/drops.ts`). Injected like
   * the clock: the translator stays pure and never logs, and the caller — which holds the request
   * id — writes the line. Absent, drops are silent.
   */
  readonly onDrop?: DropSink | undefined
  /**
   * Whether the **selected Account's** surface reads `cache_control` beyond its dialect's base
   * (`ProviderSurface.cacheControl`) — per candidate like `chatCeiling`. Absent means it does not.
   */
  readonly cacheControl?: boolean | undefined
  /** The **selected Account's** seal, per candidate like `chatCeiling` (`sealed-reasoning.ts`). */
  readonly reasoningSeal?: ReasoningSeal | undefined
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
  /**
   * The same conversion over a body already parsed for this pair's ingress
   * (`parseIngressRequest`): the parse depends only on the body, so a request whose candidates
   * need several target shapes parses once and converts per shape. Every registered pair states
   * it; a stand-in pair that does not is converted through `request`.
   */
  readonly requestFromParsed?:
    | ((parsed: ParsedIngressRequest, context: TranslationContext) => unknown)
    | undefined
  /** Upstream body → client body, for a response that did not stream. Never throws. */
  readonly response: (body: unknown, context: TranslationContext) => TranslatedResponse
  /** Upstream SSE → client SSE, one event in and zero or more out. Never throws. */
  readonly stream: (context: TranslationContext) => StreamTranslator
}
