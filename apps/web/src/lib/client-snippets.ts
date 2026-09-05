/**
 * The "point your tool at it" cookbook, as data.
 *
 * Pure — a base URL and a key value in, per-client recipes out. Split out of `KeyConnectSnippets`
 * for the reason `onboarding.ts` is split out of its panel: the part that has to be *right* (which
 * URL carries the `/v1` suffix, which env var carries the key, which mode never reaches the router)
 * is the part with no DOM in it, so it is tested without one.
 *
 * This restates the client table in `README.md` rather than linking to it. An operator holding a
 * freshly minted key should not have to leave the console to find out where to paste it — and the
 * two go out of step only if someone changes a client's wiring in one place and not the other.
 */

export interface ClientSnippet {
  /** Names the block — the copy control and assistive tech both read it. */
  readonly label: string
  readonly text: string
}

export interface ClientRecipe {
  /** Stable id: the tab's DOM id, and what a caller selects by. */
  readonly id: string
  readonly label: string
  /** One line, before the blocks: what this client wants. */
  readonly lead: string
  /** Ordered UI steps, for a client configured through its own settings screen rather than a file. */
  readonly steps: readonly string[]
  readonly snippets: readonly ClientSnippet[]
  /** The thing that bites. Stated, never dropped — `null` only when there genuinely isn't one. */
  readonly caveat: string | null
  /** A problem with *this* key for *this* client, known from the key's own scope. Rare, loud. */
  readonly warning: string | null
}

/**
 * Whether the key's scope reaches a Claude subscription (`anthropic-oauth` account) — the one fact
 * that decides if a Claude Code turn lands on a subscription or on nothing. `unknown` while the
 * pools and accounts have not loaded; never guessed.
 */
export type ClaudeReach = "reachable" | "unreachable" | "unknown"

export interface RecipeOptions {
  readonly claudeSubscriptions?: ClaudeReach
}

/**
 * The router's origin with any trailing slash removed.
 *
 * `window.location.origin` never has one, but a hand-written `PUBLIC_URL` frequently does, and
 * `https://router.example.com//v1/messages` is a 404 with a confusing cause.
 */
export function routerOrigin(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "")
}

/**
 * The OpenAI-dialect base: origin + `/v1`.
 *
 * The suffix is the single most common way this is got wrong. Every OpenAI-compatible client
 * appends `/chat/completions` (or `/models`, or `/responses`) to whatever it is given, so the
 * `/v1` has to already be there. Anthropic-dialect clients are the mirror image — they append
 * `/v1/messages` themselves and must be handed the bare origin.
 */
export function openAiBaseUrl(baseUrl: string): string {
  return `${routerOrigin(baseUrl)}/v1`
}

/**
 * Every recipe, in the order the panel shows them: the two clients most operators arrive with
 * first, then the file-configured ones, then the SDK and the raw request that proves the rest.
 */
export function clientRecipes(
  baseUrl: string,
  keyValue: string,
  options: RecipeOptions = {},
): readonly ClientRecipe[] {
  const origin = routerOrigin(baseUrl)
  const v1 = openAiBaseUrl(baseUrl)

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      lead: "Anthropic dialect, two variables. The base URL carries no /v1 suffix — Claude Code appends /v1/messages itself.",
      steps: [
        "Export exactly these two variables in the shell that runs claude. Unset ANTHROPIC_API_KEY there — a second, different key is a rejected request, not a fallback.",
        "Scope this key to a pool that contains the Claude subscriptions (anthropic-oauth accounts). That is what puts a Claude Code turn onto a subscription; a scope with none reaches API-key accounts only.",
      ],
      snippets: [
        {
          label: "Shell environment",
          text: `export ANTHROPIC_BASE_URL="${origin}"\nexport ANTHROPIC_AUTH_TOKEN="${keyValue}"`,
        },
      ],
      caveat:
        "ANTHROPIC_AUTH_TOKEN sends the key as Authorization: Bearer, ANTHROPIC_API_KEY sends it as x-api-key. The router accepts either — set both only if they carry the same value, because two different keys is a rejected request, not a fallback.",
      warning:
        options.claudeSubscriptions === "unreachable"
          ? "This key's scope reaches no Claude subscription. Claude Code will be served by API-key accounts only — or refused with 403 if none serves the model. Edit the key's scope to include the pool holding the anthropic-oauth accounts."
          : null,
    },
    {
      id: "cursor",
      label: "Cursor",
      lead: "Configured in Cursor's own settings rather than a file.",
      steps: [
        "Settings → Models → turn on Override OpenAI Base URL.",
        "Paste the base URL below. The /v1 suffix is required: Cursor appends /chat/completions to it.",
        "Paste the router key into the OpenAI API Key field, then press Verify.",
      ],
      snippets: [
        { label: "Override OpenAI Base URL", text: v1 },
        { label: "OpenAI API Key", text: keyValue },
      ],
      caveat:
        "Agent and plan mode go through the override. Tab-autocomplete and inline edit stay on Cursor's own backend and never reach the router, so they will not appear in usage.",
      warning: null,
    },
    {
      id: "codex",
      label: "Codex CLI",
      lead: "Codex reads a provider entry from ~/.codex/config.toml, and the key from the environment variable that entry names.",
      steps: [],
      snippets: [
        {
          label: "~/.codex/config.toml",
          text: [
            'model_provider = "multi-ai-router"',
            "",
            "[model_providers.multi-ai-router]",
            'name = "Multi AI Router"',
            `base_url = "${v1}"`,
            'env_key = "MULTI_AI_ROUTER_KEY"',
            'wire_api = "responses"',
          ].join("\n"),
        },
        { label: "Shell environment", text: `export MULTI_AI_ROUTER_KEY="${keyValue}"` },
      ],
      caveat:
        'wire_api = "responses" targets POST /v1/responses. Set it to "chat" to go through /v1/chat/completions instead — the router serves both.',
      warning: null,
    },
    {
      id: "aider",
      label: "Aider",
      lead: "Either dialect, through LiteLLM's environment variables. Set the pair that matches the model you send.",
      steps: [],
      snippets: [
        {
          label: "OpenAI dialect",
          text: `export OPENAI_API_BASE="${v1}"\nexport OPENAI_API_KEY="${keyValue}"\naider --model openai/gpt-4o-mini`,
        },
        {
          label: "Anthropic dialect",
          text: `export ANTHROPIC_API_BASE="${origin}"\nexport ANTHROPIC_API_KEY="${keyValue}"\naider --model anthropic/claude-sonnet-4-5`,
        },
      ],
      caveat:
        "The openai/ and anthropic/ prefixes pick the dialect LiteLLM speaks and are stripped before the request leaves, so the router sees the bare model name and passes it through unchanged.",
      warning: null,
    },
    {
      id: "openai-sdk",
      label: "OpenAI SDK",
      lead: "One argument changes: the base URL, with its /v1 suffix. The key goes where the OpenAI key went.",
      steps: [],
      snippets: [
        {
          label: "Python",
          text: [
            "from openai import OpenAI",
            "",
            "client = OpenAI(",
            `    base_url="${v1}",`,
            `    api_key="${keyValue}",`,
            ")",
            "",
            "client.chat.completions.create(",
            '    model="gpt-4o-mini",',
            '    messages=[{"role": "user", "content": "ping"}],',
            ")",
          ].join("\n"),
        },
        {
          label: "TypeScript",
          text: [
            'import OpenAI from "openai"',
            "",
            "const client = new OpenAI({",
            `  baseURL: "${v1}",`,
            `  apiKey: "${keyValue}",`,
            "})",
          ].join("\n"),
        },
      ],
      caveat:
        "Anthropic's SDKs take the same two arguments — the bare origin as the base URL, without /v1, and the router key as the API key.",
      warning: null,
    },
    {
      id: "curl",
      label: "curl",
      lead: "Ask the router what this key can reach, then send one of those names back at it.",
      steps: [],
      snippets: [
        {
          label: "Models this key can reach",
          text: `curl ${v1}/models \\\n  -H "Authorization: Bearer ${keyValue}"`,
        },
        {
          label: "OpenAI dialect",
          text: [
            `curl ${v1}/chat/completions \\`,
            `  -H "Authorization: Bearer ${keyValue}" \\`,
            '  -H "content-type: application/json" \\',
            `  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"ping"}]}'`,
          ].join("\n"),
        },
        {
          label: "Anthropic dialect",
          text: [
            `curl ${origin}/v1/messages \\`,
            `  -H "x-api-key: ${keyValue}" \\`,
            '  -H "content-type: application/json" \\',
            `  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"ping"}]}'`,
          ].join("\n"),
        },
      ],
      caveat:
        "No anthropic-version header: the router sets each provider's required headers itself and overrides a client-supplied one. Model names pass through unchanged unless the selected account defines an alias.",
      warning: null,
    },
  ]
}
