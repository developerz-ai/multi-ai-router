import type { DriverAccount, UpstreamResponse } from "../../../src/providers"

/**
 * Realistic upstream responses, recorded shapes only — no live calls, no real credentials.
 * Every body here is the wording a provider actually uses for the condition it names, because
 * the wording is exactly what the driver rules key on.
 */

export function account(overrides: Partial<DriverAccount> = {}): DriverAccount {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    provider: "anthropic-api",
    ...overrides,
  }
}

export function response(
  status: number,
  init: { headers?: Record<string, string>; body?: unknown } = {},
): UpstreamResponse {
  return {
    status,
    headers: new Headers(init.headers ?? {}),
    body: init.body,
  }
}

// --- Anthropic --------------------------------------------------------------

export const anthropicRateLimitHeaders = {
  "retry-after": "30",
  "anthropic-ratelimit-requests-limit": "50",
  "anthropic-ratelimit-requests-remaining": "0",
  "anthropic-ratelimit-requests-reset": "2026-07-24T14:32:00Z",
  "anthropic-ratelimit-input-tokens-limit": "20000",
  "anthropic-ratelimit-input-tokens-remaining": "5000",
  "anthropic-ratelimit-input-tokens-reset": "2026-07-24T14:35:00Z",
}

export const anthropicRateLimitBody = {
  type: "error",
  error: { type: "rate_limit_error", message: "Number of requests has exceeded your rate limit" },
}

/** A drained console balance: Anthropic says it with a `400`, not a `402`. */
export const anthropicCreditsBody = {
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
  },
}

export const anthropicAuthBody = {
  type: "error",
  error: { type: "authentication_error", message: "invalid x-api-key" },
}

export const anthropicServerBody = {
  type: "error",
  error: { type: "api_error", message: "Internal server error" },
}

// --- OpenAI -----------------------------------------------------------------

export const openAiRateLimitHeaders = {
  "x-ratelimit-limit-requests": "500",
  "x-ratelimit-remaining-requests": "0",
  "x-ratelimit-reset-requests": "6m0s",
  "x-ratelimit-limit-tokens": "150000",
  "x-ratelimit-remaining-tokens": "120000",
  "x-ratelimit-reset-tokens": "20ms",
}

export const openAiRateLimitBody = {
  error: {
    message:
      "Rate limit reached for gpt-4o in organization org-abc on requests per min (RPM): Limit 500, Used 500, Requested 1.",
    type: "requests",
    param: null,
    code: "rate_limit_exceeded",
  },
}

/** The flagship trap: a spent balance arrives as a **429**, not a 402. */
export const openAiInsufficientQuotaBody = {
  error: {
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs.",
    type: "insufficient_quota",
    param: null,
    code: "insufficient_quota",
  },
}

export const openAiAuthBody = {
  error: {
    message:
      "Incorrect API key provided: sk-***. You can find your API key at https://platform.openai.com/account/api-keys.",
    type: "invalid_request_error",
    param: null,
    code: "invalid_api_key",
  },
}

export const openAiServerBody = {
  error: {
    message: "The server had an error while processing your request. Sorry about that!",
    type: "server_error",
    param: null,
    code: null,
  },
}

// --- OpenRouter -------------------------------------------------------------

export const openRouterCreditsBody = {
  error: {
    code: 402,
    message: "Insufficient credits. Add more using https://openrouter.ai/settings/credits",
  },
}

export const openRouterRateLimitBody = {
  error: { code: 429, message: "Rate limit exceeded: free-models-per-day" },
}

/** OpenRouter reports the reset of its unsuffixed request budget as epoch milliseconds. */
export const openRouterRateLimitHeaders = {
  "x-ratelimit-limit": "200",
  "x-ratelimit-remaining": "0",
  "x-ratelimit-reset": "1784000000000",
}

// --- z.ai -------------------------------------------------------------------

export const zaiBalanceBody = {
  error: { code: "1113", message: "Your account balance is insufficient, please recharge." },
}

export const zaiThrottleBody = {
  error: { code: "1302", message: "API request rate limit reached, please try again later." },
}

/** Recorded live, 2026-07-27. The reset instant exists only here — the 429 carries no headers. */
export const zaiWindowExhaustedBody = {
  error: {
    type: "rate_limit_error",
    code: "1310",
    message:
      "[1310][Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-08-01 10:03:40][202607280616391a9088331cb844d2]",
  },
}

// --- Kimi -------------------------------------------------------------------

export const kimiQuotaBody = {
  type: "error",
  error: {
    type: "exceeded_current_quota_error",
    message: "Your account org-abc is not active, please check your account balance.",
  },
}

export const kimiRateLimitBody = {
  type: "error",
  error: { type: "rate_limit_reached_error", message: "Your request exceeded model token limit" },
}

/** Recorded live, 2026-07-27: a spent billing cycle, announced as a `403 permission_error`. */
export const kimiCycleLimitBody = {
  type: "error",
  error: {
    type: "permission_error",
    message:
      "You've reached your usage limit for this billing cycle. Your quota will be refreshed in the next cycle. To continue now, purchase extra usage or upgrade your plan: https://www.kimi.com/code/#pricing",
  },
}

/** The other `permission_error`: a genuine refusal, which must stay an auth failure. */
export const kimiPermissionDeniedBody = {
  type: "error",
  error: { type: "permission_error", message: "You do not have access to model k3-preview" },
}

// --- MiniMax ----------------------------------------------------------------

/** MiniMax can answer `200` and put the real outcome in `base_resp`. */
export const miniMaxBalanceBody = {
  base_resp: { status_code: 1008, status_msg: "insufficient balance" },
}

export const miniMaxThrottleBody = {
  base_resp: { status_code: 1002, status_msg: "rate limit, please try again later" },
}

export const miniMaxSuccessBody = {
  id: "msg_01",
  type: "message",
  base_resp: { status_code: 0, status_msg: "success" },
}

// --- Gemini -----------------------------------------------------------------

/**
 * Google words a failure as a canonical gRPC status beside a numeric `code` that only restates the
 * HTTP status — and it puts the retry delay in `details`, because it sends no rate-limit headers.
 */
export const geminiRateLimitBody = {
  error: {
    code: 429,
    // The trap: a *throttle* message that names billing. Reading the word alone marks the account
    // `exhausted` and no clock ever revives it.
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.QuotaFailure",
        violations: [
          { quotaMetric: "generativelanguage.googleapis.com/generate_content_requests" },
        ],
      },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "31s" },
    ],
  },
}

/** Free tier unavailable until the project is on billing — permanent until a human acts. */
export const geminiBillingBody = {
  error: {
    code: 400,
    message:
      "Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.",
    status: "FAILED_PRECONDITION",
  },
}

/** A rejected key on the compatibility surface: the canonical status carries it. */
export const geminiUnauthenticatedBody = {
  error: {
    code: 401,
    message: "Request had invalid authentication credentials.",
    status: "UNAUTHENTICATED",
  },
}

/** The other form: the Generative Language API calls a malformed key a *client* mistake. */
export const geminiBadKeyBody = {
  error: {
    code: 400,
    message: "API key not valid. Please pass a valid API key.",
    status: "INVALID_ARGUMENT",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "API_KEY_INVALID",
        domain: "googleapis.com",
      },
    ],
  },
}

export const geminiOverloadBody = {
  error: {
    code: 503,
    message: "The model is overloaded. Please try again later.",
    status: "UNAVAILABLE",
  },
}
