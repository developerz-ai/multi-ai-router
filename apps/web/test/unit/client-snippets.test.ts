import { describe, expect, test } from "bun:test"
import {
  type ClientRecipe,
  clientRecipes,
  openAiBaseUrl,
  routerOrigin,
} from "../../src/lib/client-snippets"

const BASE = "https://router.example.com"
const KEY = "mar_live_0123456789abcdef"

const recipes = () => clientRecipes(BASE, KEY)
const recipe = (id: string): ClientRecipe => {
  const found = recipes().find((candidate) => candidate.id === id)
  if (found === undefined) throw new Error(`no recipe "${id}"`)
  return found
}
const text = (id: string): string =>
  recipe(id)
    .snippets.map((snippet) => snippet.text)
    .join("\n")

describe("routerOrigin", () => {
  test("drops a trailing slash so a path can be appended without doubling it", () => {
    expect(routerOrigin("https://router.example.com/")).toBe("https://router.example.com")
    expect(routerOrigin("https://router.example.com///")).toBe("https://router.example.com")
    expect(routerOrigin("https://router.example.com")).toBe("https://router.example.com")
  })

  test("leaves a path-prefixed deployment alone", () => {
    expect(routerOrigin("https://ops.example.com/router")).toBe("https://ops.example.com/router")
  })
})

describe("openAiBaseUrl", () => {
  test("appends the /v1 suffix every OpenAI-compatible client expects", () => {
    expect(openAiBaseUrl(BASE)).toBe("https://router.example.com/v1")
  })

  test("appends it exactly once when the operator's PUBLIC_URL has a trailing slash", () => {
    expect(openAiBaseUrl("https://router.example.com/")).toBe("https://router.example.com/v1")
  })
})

describe("clientRecipes", () => {
  test("covers the six clients the console promises, each with a stable unique id", () => {
    const ids = recipes().map((entry) => entry.id)
    expect(ids).toEqual(["claude-code", "cursor", "codex", "aider", "openai-sdk", "curl"])
    expect(new Set(ids).size).toBe(ids.length)
  })

  test("fills in the operator's real key — never a YOUR_KEY_HERE placeholder", () => {
    for (const entry of recipes()) {
      expect(entry.snippets.some((snippet) => snippet.text.includes(KEY))).toBe(true)
    }
    const joined = recipes()
      .flatMap((entry) => entry.snippets.map((snippet) => snippet.text))
      .join("\n")
    expect(joined).not.toMatch(/YOUR_|<key>|xxx|\.\.\./i)
  })

  test("every snippet is a non-empty block with a label to copy it by", () => {
    for (const entry of recipes()) {
      expect(entry.snippets.length).toBeGreaterThan(0)
      for (const snippet of entry.snippets) {
        expect(snippet.label.length).toBeGreaterThan(0)
        expect(snippet.text.trim()).toBe(snippet.text)
      }
    }
  })

  test("Anthropic-dialect clients get the bare origin — they append /v1/messages themselves", () => {
    expect(text("claude-code")).toContain(`ANTHROPIC_BASE_URL="${BASE}"`)
    expect(text("claude-code")).toContain(`ANTHROPIC_AUTH_TOKEN="${KEY}"`)
    expect(text("claude-code")).not.toContain(`${BASE}/v1`)
    expect(text("aider")).toContain(`ANTHROPIC_API_BASE="${BASE}"`)
  })

  test("OpenAI-dialect clients get the /v1 suffix, because they append /chat/completions", () => {
    expect(recipe("cursor").snippets[0]?.text).toBe(`${BASE}/v1`)
    expect(text("aider")).toContain(`OPENAI_API_BASE="${BASE}/v1"`)
    expect(text("openai-sdk")).toContain(`base_url="${BASE}/v1"`)
    expect(text("openai-sdk")).toContain(`baseURL: "${BASE}/v1"`)
    expect(text("codex")).toContain(`base_url = "${BASE}/v1"`)
  })

  test("Cursor is steps plus two paste-ins, and names what never reaches the router", () => {
    const cursor = recipe("cursor")
    expect(cursor.steps.length).toBeGreaterThan(0)
    expect(cursor.steps.join(" ")).toContain("/v1")
    expect(cursor.snippets.map((snippet) => snippet.text)).toEqual([`${BASE}/v1`, KEY])
    expect(cursor.caveat).toContain("Tab-autocomplete")
  })

  test("the Codex block is a whole ~/.codex/config.toml provider entry, key by env var", () => {
    const config = recipe("codex").snippets[0]
    expect(config?.label).toBe("~/.codex/config.toml")
    expect(config?.text).toContain('model_provider = "multi-ai-router"')
    expect(config?.text).toContain("[model_providers.multi-ai-router]")
    expect(config?.text).toContain('env_key = "MULTI_AI_ROUTER_KEY"')
    // The key itself belongs in the environment, not checked into a dotfile.
    expect(config?.text).not.toContain(KEY)
    expect(text("codex")).toContain(`export MULTI_AI_ROUTER_KEY="${KEY}"`)
  })

  test("curl leads with /v1/models — the cheapest proof the key reaches something", () => {
    expect(recipe("curl").snippets[0]?.text).toContain(`${BASE}/v1/models`)
    expect(text("curl")).toContain(`${BASE}/v1/chat/completions`)
    expect(text("curl")).toContain(`${BASE}/v1/messages`)
    expect(text("curl")).toContain(`Authorization: Bearer ${KEY}`)
    expect(text("curl")).toContain(`x-api-key: ${KEY}`)
  })

  test("tracks the operator's own base URL rather than a hardcoded host", () => {
    const local = clientRecipes("http://localhost:8080/", KEY)
    const joined = local.flatMap((entry) => entry.snippets.map((s) => s.text)).join("\n")
    expect(joined).toContain("http://localhost:8080/v1")
    expect(joined).not.toContain("router.example.com")
    expect(joined).not.toContain("localhost:8080//v1")
  })
})
