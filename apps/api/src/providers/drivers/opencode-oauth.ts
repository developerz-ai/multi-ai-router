import { UpstreamAuthError } from "@multi-ai-router/core"
import { z } from "zod"
import type { ProviderDeviceFlow } from "../device-flow"
import { createHttpDriver } from "../driver"
import { messageRule, typeRule } from "../failure/classify"
import type { OAuthTokenRequest, OAuthTokens, ProviderDriver } from "../types"
import { OPENCODE_OVERLOADED } from "./opencode-failures"
import { opencodeChatModelListing } from "./opencode-models"

// Provenance: OpenCode 2.2.5 MITM, 2026-11-07; upstream source fe04656465,
// core/src/plugin/provider/opencode.ts + console-access.ts. Blast radius: Console login,
// refresh and inference only; the personal API keys on opencode-go are independent.
const CONSOLE = "https://opencode.ai/console"
const CLIENT_ID = "opencode-cli"
const TOKEN_URL = `${CONSOLE}/auth/device/token`
// Honest router identity accepted by the live catalog and free-limit response on 2026-11-07.
const USER_AGENT = "developerz.ai"
const HEADERS = { "content-type": "application/json", "user-agent": USER_AGENT }

function post(url: string, body: unknown): OAuthTokenRequest {
  return { url, method: "POST", headers: HEADERS, body: JSON.stringify(body) }
}

const Token = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  expires_in: z.number().positive().finite(),
  org_id: z.string().trim().min(1).nullish(),
})

export function readOpenCodeTokens(body: unknown, previousOrg?: string): OAuthTokens | null {
  const parsed = Token.safeParse(body)
  if (!parsed.success) return null
  const org = parsed.data.org_id ?? previousOrg
  // A fresh org-scoped login must identify its workspace. Never silently choose another.
  if (!org) return null
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token,
    expiresInSeconds: parsed.data.expires_in,
    providerAccountId: org,
  }
}

const UserCode = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  expires_in: z.number().positive().finite(),
  interval: z.number().positive().finite(),
})
const Pending = z.object({ error: z.string() })

export const opencodeDeviceFlow: ProviderDeviceFlow = {
  verificationUrl: `${CONSOLE}/device`,
  redirectUri: `${CONSOLE}/device`,
  defaultIntervalSeconds: 5,
  waitBeforeFirstPoll: true,
  userCodeRequest: () =>
    post(`${CONSOLE}/auth/device/code`, {
      client_id: CLIENT_ID,
      supports_org_scope: true,
    }),
  readUserCode: (body) => {
    const parsed = UserCode.safeParse(body)
    return parsed.success
      ? {
          deviceAuthId: parsed.data.device_code,
          userCode: parsed.data.user_code,
          intervalSeconds: parsed.data.interval,
          expiresInSeconds: parsed.data.expires_in,
        }
      : null
  },
  pollRequest: ({ deviceAuthId }) =>
    post(TOKEN_URL, {
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: deviceAuthId,
      client_id: CLIENT_ID,
    }),
  readPoll: (status, body, headers) => {
    if (status >= 200 && status < 300) {
      const tokens = readOpenCodeTokens(body)
      return tokens === null ? { kind: "refused" } : { kind: "tokens", tokens }
    }
    const pending = Pending.safeParse(body)
    if (status === 400 && pending.success) {
      if (pending.data.error === "authorization_pending") return { kind: "pending" }
      if (pending.data.error === "slow_down") return { kind: "slow-down", increaseSeconds: 5 }
    }
    if (status === 429 || status >= 500) {
      const retry = Number(headers?.get("retry-after"))
      return {
        kind: "retry",
        throttled: true,
        retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
      }
    }
    return { kind: "refused" }
  },
}

const driver = createHttpDriver({
  id: "opencode-oauth",
  authKind: "oauth",
  surfaces: [
    {
      dialect: "openai-chat",
      baseUrl: "https://opencode.ai/inference/openai/v1",
      sessionHeader: "x-opencode-session",
      chatCeiling: "max_completion_tokens",
    },
  ],
  rules: [
    messageRule("overloaded", "opencode:overloaded", OPENCODE_OVERLOADED),
    typeRule("rate-limited", "opencode:free-usage-limit", ["FreeUsageLimitError"]),
    messageRule("credits-exhausted", "opencode:insufficient-funds", /insufficient account funds/i),
    messageRule("model-unsupported", "opencode:model-unavailable", /model is unavailable/i),
  ],
})

function deviceOnly(): never {
  throw new Error("OpenCode Console uses device sign-in")
}

export const opencodeOAuthDriver: ProviderDriver = {
  ...driver,
  modelListing: opencodeChatModelListing,
  oauth: {
    loopbackRedirectUri: opencodeDeviceFlow.redirectUri,
    authorizeUrl: deviceOnly,
    codeExchange: deviceOnly,
    device: opencodeDeviceFlow,
    refresh: ({ refreshToken }) =>
      post(TOKEN_URL, {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: CLIENT_ID,
      }),
    readTokens: (body, context) => readOpenCodeTokens(body, context?.previousProviderAccountId),
  },
  buildHeaders: (account, credential) => {
    if (credential?.kind !== "oauth" || !credential.providerAccountId)
      throw new UpstreamAuthError(`account ${account.id}: OpenCode Console needs a workspace login`)
    const headers = driver.buildHeaders(account, credential)
    headers.set("x-opencode-org-id", credential.providerAccountId)
    headers.set("user-agent", USER_AGENT)
    return headers
  },
}
