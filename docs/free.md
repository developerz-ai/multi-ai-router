# Free models

What costs nothing, what each one needs from you, and how to use it. Read off each vendor's own page on
**2026-11-23** unless it says otherwise; `.dz/briefs/free-providers.md` re-checks it daily.

## Add one in a minute

Console → **Accounts** → **Add account**. Providers with a free tier say so in the list.

| Needs | Provider in the console | Where the key comes from | Allowance | Catch |
|---|---|---|---|---|
| **Nothing** | `kilo` | none: leave the credential empty | 200 requests an hour per address | Free ids rotate. A Kilo key is optional |
| **Email, phone check** | `nvidia` | [build.nvidia.com](https://build.nvidia.com/settings/api-keys) | about 40 requests a minute, 10,000 a day, varying by model | Terms: development, not serving end users |
| **Email** | `openrouter` | [openrouter.ai](https://openrouter.ai/workspaces/default/keys) | `:free` ids: 20 a minute, 50 a day; 1,000 a day once the workspace has bought $10 | Per workspace: a second key adds nothing. A negative balance can refuse free ids too |
| **Google account** | `gemini` | [AI Studio](https://aistudio.google.com/app/apikey) | per project, shown in AI Studio | Use a project with no billing. Not ranked: the same ids are billed on a paid project |
| **Email** | `groq` | [console.groq.com](https://console.groq.com/keys) | 30 a minute, 1,000 a day, **8,000 tokens a minute** | Too small for an agent's prompt. Not ranked, as `gemini` |

### Presets

Choose `openai-compatible`, then **Free service**: the base URL and the free ids fill themselves in
(`apps/api/src/providers/free-presets.ts`).

| Service | Best free models | Allowance |
|---|---|---|
| AIHubMix | GLM-5.3, MiMo v2.6 Pro, GLM-5.3 Flash | 100 a day and 1M tokens a day **per model** |
| Token Harbor | DeepSeek V4.1 Flash, MiMo v2.6 Flash | 1,800 an hour under a weekly allowance |
| Routeway | DeepSeek V4.1 Flash, MiniMax M3.1 Flash | 200 a day |
| Nous Portal | Hy4 Flash, Step 3.7 Flash | unpublished |
| OrcaRouter | DeepSeek V4.1 Flash, GLM-5.3 Flash | 50 a day; aged GitHub account |
| Requesty | Nemotron 3 Ultra | 200 a day; keep no credit on it |
| Z.ai | GLM-4.7 Flash | unpublished, about one at a time |
| Agnes, LLMTR, Merkium | their own and small models | see the console note |
| *Trial:* Dahl | GLM-5.3 Flash, DeepSeek V4 Flash | **100M tokens once**, for a username |
| *Trial:* Inception | Mercury 3 | **100M tokens once** |
| *Trial:* Alibaba (international) | Qwen3.8 Max, GLM-5.3, DeepSeek V4.1 Flash | about 1M tokens per model, 90 days |
| *Trial:* IteraCompute, Regolo | Qwen3.8 27B, GLM-5.2 | 30M a month; 1M a day for 30 days |

Cloudflare Workers AI (`https://api.cloudflare.com/client/v4/accounts/<id>/ai/v1`, 10,000 neurons a day) is the
same kind of account with your own account id in the address.

## Two things to know before an agent uses one

- **A gateway you do not know can answer with a tool call of its own.** A coding agent runs what its model asks
  for, so an unvetted free gateway belongs on text jobs. For agents that execute tools, prefer the vendors that run the
  models: NVIDIA, Google, Groq, Z.ai, and OpenRouter's or Kilo's named models.
- **Hosts may log prompts and train on them.** That is usually what pays for a free tier.

## Use it

- **`"model": "free"`**: the router tries the smartest free model your key reaches, then the next, until one answers.
  It never bills anything, and no other model name is ever moved onto it.
- **`GET /v1/free-models`**: the same list, smartest first, to pick from yourself.
- **As a fallback**: name your own model first and send `free` when that fails. The router does not make that choice
  for you: the client picks the model.

Scope it like anything else: a pool holding the free accounts, and a router key scoped to that pool.
More than one account of the same provider is fine where its terms allow it.

## Not worth adding

| Service | Why |
|---|---|
| OVHcloud, anonymous | Answers one request per model per address **a year** (`x-ratelimit-limit-year: 1`, live) |
| OpenCode Zen free models | Refused outside OpenCode |
| GitHub Models | Retired 2026-07-30 |
| Mistral free mode | Its docs now say it does not include API access |
| Cerebras | A one-time $5 trial with a payment method |
| Cohere trial keys | Evaluation only |
| Hugging Face, Ollama Cloud | No free allowance today |
| FreeInference (Harvard) | Paused after a security incident |
| BlockRun | Substitutes another model silently |
| ModelScope, SiliconFlow and most Chinese free grants | Real-name identity check |
