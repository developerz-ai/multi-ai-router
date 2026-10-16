# Thinking modes × forced tool choice × caching (cross-provider)

Research backing the translation rules that keep the router *serving* instead of
emitting a router-made 400 when a client forces a tool on a model that reasons.
Captured 2026-10-16. Sources are mostly secondary (community + framework docs);
treat provider behaviour as drift-prone and re-confirm against the vendor's own
docs before changing a pinned rule. No real credentials or captures live here.

## The failure we observed in prod

`/v1/messages` (anthropic ingress) with `tool_choice` forcing a specific tool
(`{type:"tool"}`) or any tool (`{type:"any"}`), translated to the OpenAI-chat
egress of a reasoning model:

- **MiniMax-M3** (key `team`, Vercel AI SDK `generateObject`): 538 router-made
  400s/week once v2.37.3 shipped a guard that *threw* `TranslationError` when
  `thinking` was `enabled`/`adaptive` beside a forced tool.
- **qwen3.8-max** (`openai-compatible`, account `alibaba-qwen38-tokenplan`):
  ~284 upstream 400s, `"The tool_choice parameter does not support being set to
  required or object in thinking mode"`.

## Provider behaviour

### Qwen (Alibaba Model Studio / DashScope, OpenAI-compatible)

- With **thinking enabled**, the OpenAI-compatible endpoint rejects
  `tool_choice: "required"` and named/object tool choice — only `"auto"` / `"none"`
  are accepted. (LangChain issue #40897; Model Studio deep-thinking docs.)
- The dial is **`enable_thinking`**, passed in the body (`extra_body` in the
  OpenAI SDKs; a plain top-level body field on the wire). Not OpenAI-standard, so
  a vanilla OpenAI/Codex endpoint would 400 on it — inject it **only** for
  known think-by-default OpenAI-compatible targets.
- **Defaults vary by model, so the model id is the determinant:**
  - `qwen3.8-max`, `qwen3.8-flash` (the "3.8" hybrid series): **thinking ON by default.**
  - older `qwen3-max/plus/flash/turbo`: thinking OFF by default.
  - `*-instruct` (e.g. Qwen3-Instruct-2507): thinking unsupported / cannot toggle.
  - `*-thinking`: thinking-only, cannot disable.
- Qwen thinking mode also does **not** support structured-output JSON-schema
  enforcement — another reason a `generateObject` forced-tool call needs thinking off.

### MiniMax-M3

- Thinking default when `thinking` is omitted is **contested** (one source: adaptive;
  another: off). Set `thinking` **explicitly** rather than relying on the default.
- Third-party reports that `tool_choice` forcing may not reliably compel a call and
  that only `auto`/`none` are documented. The router's contract is: the force wins,
  the reasoning dial yields — so we send `thinking:{type:"disabled"}` explicitly and
  rely on the downstream JSON→tool_use coercion (shipped v2.37.4) if the model
  answers in prose anyway.

## Router rule (what we implement)

1. **Anthropic passthrough / think-by-default anthropic-compatible providers**
   (`dataplane/body/forced-tool-thinking.ts`): a forced `tool_choice` with
   `thinking` absent / `enabled` / `adaptive` → rewrite to `{type:"disabled"}` and
   serve. Never throw. The force is the contract; the reasoning dial yields.
2. **anthropic → openai-chat translation**
   (`services/translate/anthropic-to-openai-chat`): when the surviving
   `tool_choice` forces a tool, drop a client-sent `thinking`/`reasoning_effort`
   (so no effort is sent), AND, for an egress model known to think by default,
   emit `enable_thinking:false`. The think-by-default model set is **config**
   (`OPENAI_CHAT_THINKING_DEFAULT_MODELS`), not a constant, because the roster
   drifts and pooling means many accounts of one provider.
3. The **model name is never changed** (non-negotiable 4) — `enable_thinking` and
   `thinking:disabled` are vendor dials, not a re-route or a substitution.
4. OpenAI / Codex (`openai-responses`) are **not** touched — they serve the
   forced-tool + reasoning pair natively; injecting a non-standard dial there is a
   regression.

## Caching notes (Anthropic / Agent-SDK path — the SDK owns it, we don't touch it)

**The Agent SDK / `claude` CLI already manages prompt caching** on the Claude
subscription path — it places the `cache_control` breakpoints on the tools/system
prefix itself. The router neither adds nor moves breakpoints; its only job is to
not break the CLI's replay (a broken resume shows up as flat `cache_read` with
growing `cache_write` — see the SDK cache-debugging playbook). The mechanics below
are why disturbing the prefix is costly, not a thing we implement.

- Prompt-cache matching is prefix-based; cache order is **tools → system →
  messages**, max **4 `cache_control` breakpoints** (a 5th → 400). A byte change at
  one level invalidates that level and everything after it.
- In an extended-thinking turn, passing **non-tool** content removes prior
  `thinking` blocks and later context from the cache; tool_result content keeps
  them intact. Redacted (encrypted) thinking blocks must be preserved verbatim for
  later calls.
- Implication for translation: never reorder tools/system/messages or drop/rewrite
  a `thinking` block on the Claude path, or the client's cache breaks (flat
  `cache_read`, growing `cache_write` — see the SDK cache-debugging playbook).

## Sources

- Qwen named tool_choice rejected with thinking enabled — https://github.com/langchain-ai/langchain/issues/40897
- `enable_thinking` not forwarded to `extra_body` — https://github.com/agentscope-ai/agentscope/issues/1765
- Qwen quickstart / vLLM `enable_thinking` — https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html , https://qwen.readthedocs.io/en/latest/deployment/vllm.html
- Model Studio deep-thinking (defaults by series) — https://www.alibabacloud.com/help/en/model-studio/deep-thinking
- MiniMax function calling / thinking defaults — https://java.agentscope.io/v2/en/integration/model/minimax.md , https://minimax-ai.chat/?p=1977
- Anthropic prompt-caching breakpoints & thinking — https://hidekazu-konishi.com/tools/prompt_caching_breakpoint_planner_tool.html
