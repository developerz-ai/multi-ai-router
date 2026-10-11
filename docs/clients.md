# Client cookbook

Config-file snippets for pointing a client at the router, plus the one command that proves it
landed. The [README](../README.md#-pointing-your-client-at-it) carries the short version — the
base URL and the key — and this is the long one, for the clients that read a config file rather
than an environment variable.

Router keys are accepted in both dialects: `Authorization: Bearer mar_live_…` and
`x-api-key: mar_live_…`. Anything that can set a base URL and a key works; what follows is what
the console's own client snippets cover today. There is **no automated integration test against
each of these clients** — treat this as a documented list, not a verified one.

**The console says all of this too, filled in.** Mint or reveal a key and the dialog carries a
**Point your tool at it** panel — tabs for Claude Code, Cursor, Codex CLI, Aider, the OpenAI SDKs
and `curl`, each block already containing this deployment's base URL (`PUBLIC_URL`, else the
console's own origin) and that key's real value. Everything below is the same content for someone
who never opened the console.

Every block uses `http://localhost:8080` and `mar_live_…` — swap in your own.

---

## Verify it landed on the router, not the real upstream

Do this before wiring in a real workload. `GET /v1/models` only answers once at least one account
has declared a catalog ([see below](#tell-each-account-what-it-serves)), so a `200` with a list you
recognize — or an empty `data: []` from an undeclared account — is the router. A DNS error, or a
TLS handshake against a provider's real hostname, means the base URL never took:

```bash
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .
```

---

## Environment-variable clients

Claude Code, Aider, and anything else that reads the standard variables:

```bash
# Claude Code, or anything reading the Anthropic env vars
export ANTHROPIC_BASE_URL="http://localhost:8080"
export ANTHROPIC_AUTH_TOKEN="mar_live_…"

# any OpenAI-compatible client — note the /v1 suffix
export OPENAI_BASE_URL="http://localhost:8080/v1"
export OPENAI_API_KEY="mar_live_…"
```

## Cursor

Settings → Models → **Override OpenAI Base URL** = `https://router.example.com/v1` (the `/v1`
suffix is required — Cursor appends `/chat/completions`), then paste the router key into the
"OpenAI API Key" field. Agent and plan mode route through the override; **tab-autocomplete and
inline-edit stay on Cursor's own backend** and never reach the router.

## Codex CLI

`~/.codex/config.toml`:

```toml
[model_providers.multi_ai_router]
name = "multi-ai-router"
base_url = "http://localhost:8080/v1"
env_key = "MULTI_AI_ROUTER_API_KEY"   # set this env var to your mar_live_… key

[profiles.router]
model_provider = "multi_ai_router"
model = "gpt-5"   # whatever model name the account behind it serves
```

```bash
export MULTI_AI_ROUTER_API_KEY="mar_live_…"
codex --profile router
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer $MULTI_AI_ROUTER_API_KEY" | jq .
```

## Cline / Roo Code

VS Code `settings.json` (or the extension's own settings UI, same fields):

```json
{
  "cline.apiProvider": "openai",
  "cline.openAiBaseUrl": "http://localhost:8080/v1",
  "cline.openAiApiKey": "mar_live_…",
  "cline.openAiModelId": "gpt-5"
}
```

```bash
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .
```

## OpenAI SDK — Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8080/v1", api_key="mar_live_…")
resp = client.chat.completions.create(
    model="gpt-5",
    messages=[{"role": "user", "content": "hello"}],
)
print(resp.choices[0].message.content)
```

## OpenAI SDK — Node

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "mar_live_…" });
const resp = await client.chat.completions.create({
  model: "gpt-5",
  messages: [{ role: "user", content: "hello" }],
});
console.log(resp.choices[0].message.content);
```

```bash
# Same verification for both SDKs — the base URL is what changed, not the wire protocol
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq '.data[].id'
```

## LangChain (Python)

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(base_url="http://localhost:8080/v1", api_key="mar_live_…", model="gpt-5")
print(llm.invoke("hello").content)
```

Anthropic-dialect accounts work the same way through `langchain_anthropic.ChatAnthropic(base_url=...)`
— pick the dialect that matches the account behind the key, or rely on cross-dialect translation
(below) and use whichever `langchain_*` package your chain already imports.

## LiteLLM

Proxy `config.yaml`:

```yaml
model_list:
  - model_name: gpt-5
    litellm_params:
      model: openai/gpt-5        # LiteLLM's own routing prefix, unrelated to the router's dialect
      api_base: http://localhost:8080/v1
      api_key: mar_live_…
```

```bash
litellm --config config.yaml &
curl -s http://localhost:4000/v1/models | jq .   # LiteLLM's own port, proxying through to the router
curl -s http://localhost:8080/v1/models -H "Authorization: Bearer mar_live_…" | jq .   # the router directly
```

---

## Tell each account what it serves

**If your tool fills a model picker from `GET /v1/models`, this matters.** An account that declares
nothing accepts any model name you send — that is the default and it is not broken — but the router
will not enumerate a catalog it was never given, so the listing comes back empty. Press
**Discover** on the account's row and the router reads the provider's own `/v1/models` and fills it
in; the field is editable by hand too. Nothing refreshes it on a timer, so a provider retiring a
model never silently moves your traffic.

## Model names and dialects

Send whatever model name you normally send. It passes through unchanged unless the selected account
defines an alias map — details in
[`docs/idea/06-protocol-translation.md`](idea/06-protocol-translation.md).

**Cross-dialect translation is live** — an Anthropic-dialect client can reach an OpenAI-dialect
account and back, including streaming and tool calls. The one exception is a request shape that
cannot be translated faithfully (a lossy edge documented in the same file): that fails with a `400`
naming the reason rather than being converted approximately.

---

## Read next

| Doc | Covers |
|---|---|
| [`idea/04-api-keys-and-access.md`](idea/04-api-keys-and-access.md) | Minting keys, scope, what a `401` means |
| [`idea/06-protocol-translation.md`](idea/06-protocol-translation.md) | Ingress × egress matrix, streaming, tool calls, aliases |
| [`idea/09-deployment.md#troubleshooting`](idea/09-deployment.md#troubleshooting) | Symptom → cause → fix, including client-side `401`s |
