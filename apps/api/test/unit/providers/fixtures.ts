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
