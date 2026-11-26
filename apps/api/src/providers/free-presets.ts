/**
 * Free services that need no driver: an `openai-compatible` Account with this base URL, a key from
 * this page, and these ids declared. The console fills its add form from a row, so adding one is a
 * paste rather than a documentation hunt.
 *
 * Data only. Nothing here is contacted, and no row grants anything: an operator still makes the key
 * and the Account. Re-checked weekly by `.dz/schedules/free-providers.md`.
 *
 * `models` are the ids that cost nothing there, and they are what the Account should declare: the
 * same key bills every other id once it holds credit.
 */
export interface FreePreset {
  readonly id: string
  readonly name: string
  readonly baseUrl: string
  readonly keyUrl: string
  readonly models: readonly string[]
  readonly note: string
  /** `standing`: renews by itself. `trial`: a one-time grant or a dated offer. */
  readonly kind: "standing" | "trial"
}

/**
 * Provenance: each base URL answered, and each allowance was read off the vendor page that
 * mvalentsev/awesome-free-ai-coding probes, 2026-11-23. Left out: an identity document or a card to
 * sign up, terms that forbid calls from a server, silent model substitution, anonymous lanes, and AIHubMix,
 * which answers a spent account `200` with the refusal as the message.
 */
export const FREE_PRESETS: readonly FreePreset[] = [
  {
    // https://developers.cloudflare.com/workers-ai/platform/pricing/ (2026-11-25).
    id: "cloudflare-workers-ai",
    name: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/ACCOUNT_ID/ai/v1",
    keyUrl: "https://developers.cloudflare.com/workers-ai/get-started/rest-api/",
    models: ["@cf/openai/gpt-oss-120b", "@cf/qwen/qwen3.8-27b", "@cf/openai/gpt-oss-20b"],
    note: "Replace ACCOUNT_ID in the base URL. Workers Free includes 10,000 Neurons per day; Workers Paid bills over that allocation.",
    kind: "standing",
  },
  {
    id: "token-harbor",
    name: "Token Harbor",
    baseUrl: "https://tokenharbor.ai/v1",
    keyUrl: "https://tokenharbor.ai/dashboard/api-keys",
    models: ["deepseek-v4.1-flash:free", "mimo-v2.6-flash:free"],
    note: "60 requests a minute, 1,800 an hour, under an unpublished weekly allowance. Turn free models on in its dashboard first.",
    kind: "standing",
  },
  {
    id: "routeway",
    name: "Routeway",
    baseUrl: "https://api.routeway.ai/v1",
    keyUrl: "https://routeway.ai/dashboard/keys",
    models: ["deepseek-v4.1-flash:free", "minimax-m3.1-flash:free", "muse-glimmer-30b:free"],
    note: "200 requests a day, 5 to 20 a minute (its pages disagree).",
    kind: "standing",
  },
  {
    id: "nous-portal",
    name: "Nous Portal",
    baseUrl: "https://inference-api.nousresearch.com/v1",
    keyUrl: "https://portal.nousresearch.com",
    models: ["tencent/hy4-flash:free", "stepfun/step-3.7-flash:free", "meituan/longcat-2.5:free"],
    note: "Free plan, unpublished allowance. Use the exact :free ids.",
    kind: "standing",
  },
  {
    id: "orcarouter",
    name: "OrcaRouter",
    baseUrl: "https://api.orcarouter.ai/v1",
    keyUrl: "https://www.orcarouter.ai",
    models: [
      "deepseek/deepseek-v4.1-flash-free",
      "z-ai/glm-5.3-flash-free",
      "deepseek/deepseek-v4-flash-free",
    ],
    note: "10 requests a minute, 50 a day. Needs an aged GitHub account.",
    kind: "standing",
  },
  {
    id: "requesty",
    name: "Requesty",
    baseUrl: "https://router.requesty.ai/v1",
    keyUrl: "https://app.requesty.ai/api-keys",
    models: ["nvidia/nemotron-3-ultra-550b-a55b", "novita/ling-3.1-flash", "google/gemma-4-31b-it"],
    note: "200 requests a day, one at a time without a balance. Free ids carry no suffix: keep no credit on the account.",
    kind: "standing",
  },
  {
    id: "zai-free",
    name: "Z.ai, free Flash models",
    baseUrl: "https://api.z.ai/api/paas/v4",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    models: ["glm-4.7-flash", "glm-4.5-flash"],
    note: "Unpublished allowance, reportedly one request at a time. A standard key, not a Coding Plan one.",
    kind: "standing",
  },
  {
    id: "agnes",
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    keyUrl: "https://platform.agnes-ai.com",
    models: ["agnes-3.0-flash", "agnes-2.5-flash"],
    note: "Flash models are zero-priced today; the rate limit is per account.",
    kind: "standing",
  },
  {
    id: "llmtr",
    name: "LLMTR",
    baseUrl: "https://llmtr.com/v1",
    keyUrl: "https://llmtr.com/dashboard/api-keys",
    models: ["nvidia/nemotron-3.5-super-vl-free", "qwen/qwen3.8-27b-free"],
    note: "Daily allowance per model, unpublished.",
    kind: "standing",
  },
  {
    id: "merkium",
    name: "Merkium",
    baseUrl: "https://chat.merkium.nl/api/v1",
    keyUrl: "https://chat.merkium.nl",
    models: ["pluto-1.2-pro", "ceres-1.0-pro", "pluto-1.2-flash"],
    note: "30 requests a minute, at least two seconds apart. Its own models.",
    kind: "standing",
  },
  {
    id: "iteracompute",
    name: "IteraCompute",
    baseUrl: "https://api.iteracompute.com/v1",
    keyUrl: "https://platform.iteracompute.com/api-keys",
    models: ["qwen/qwen3.8-27b"],
    note: "30M tokens a month. The no-recharge promotion is dated and may have ended.",
    kind: "trial",
  },
  {
    id: "dahl",
    name: "Dahl Inference",
    baseUrl: "https://inference.dahl.global/v1",
    keyUrl: "https://inference.dahl.global/account",
    models: [
      "zai-org/GLM-5.3-Flash",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "MiniMaxAI/MiniMax-M2.7",
    ],
    note: "100M tokens once, for a username. A new key answers 402 until tokens are allocated to it, and paid accounts are admitted first: busy on 2026-11-23.",
    kind: "trial",
  },
  {
    id: "inception",
    name: "Inception (Mercury)",
    baseUrl: "https://api.inceptionlabs.ai/v1",
    keyUrl: "https://platform.inceptionlabs.ai",
    models: ["mercury-3"],
    note: "100M tokens once, no payment details.",
    kind: "trial",
  },
  {
    id: "alibaba-intl",
    name: "Alibaba Model Studio (international)",
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    keyUrl: "https://modelstudio.console.alibabacloud.com",
    models: ["qwen3.8-max", "qwen3.8-flash", "deepseek-v4.1-flash", "glm-5.3", "deepseek-v4-pro"],
    note: "Typically 1M tokens per model for 90 days. Turn on stop-when-free-quota-is-used first.",
    kind: "trial",
  },
  {
    id: "regolo",
    name: "Regolo AI",
    baseUrl: "https://api.regolo.ai/v1",
    keyUrl: "https://dashboard.regolo.ai",
    models: ["glm5.2", "qwen3.8-27b", "gpt-oss-120b"],
    note: "1M tokens a day for 30 days.",
    kind: "trial",
  },
]
