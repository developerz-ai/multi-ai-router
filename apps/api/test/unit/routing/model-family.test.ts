import { describe, expect, test } from "bun:test"
import { providerModelFamily } from "../../../src/providers/registry"
import {
  type AccountSnapshot,
  inModelFamily,
  type ModelFamily,
  resolveModel,
  selectAccounts,
} from "../../../src/services/routing"
import { account, at, ids, pool, snapshot } from "./fixtures"

/**
 * One key, many vendors, picked by model name.
 *
 * The production shape (2026-10-04): a key scoped to four Claude subscriptions, one ChatGPT
 * subscription and several Chinese-model accounts. The subscriptions declare no `supportedModels`,
 * and "declares nothing" used to mean "serves everything" — so `gpt-5.5` could land on Claude and
 * `glm-5.3` on ChatGPT, an upstream rejection with the right account sitting in scope. The
 * Chinese accounts also carry `claude-opus-5 -> glm-5.2` aliases for a second, Chinese-only key,
 * which must keep working while the mixed key sends `claude-opus-5` to Claude.
 */

const CLAUDE = providerModelFamily("anthropic-oauth")
const CODEX: ModelFamily = providerModelFamily("openai-oauth") ?? { patterns: [] }

const CHINESE_ALIASES = { "claude-opus-5": "glm-5.2", sonnet: "glm-5.2" }

function claudeSub(id: string, overrides: Partial<AccountSnapshot> = {}): AccountSnapshot {
  return account(id, {
    provider: "anthropic-oauth",
    ...(CLAUDE === undefined ? {} : { modelFamily: CLAUDE }),
    ...overrides,
  })
}

const claude = [claudeSub("claude-1"), claudeSub("claude-2")]
const codex = account("codex", { provider: "openai-oauth", modelFamily: CODEX })
const zai = account("zai", { provider: "zai", modelAliases: CHINESE_ALIASES })
const minimax = account("minimax", { provider: "minimax", modelAliases: CHINESE_ALIASES })
const everyone = [...claude, codex, zai, minimax]

function selectFor(
  model: string,
  accounts: readonly AccountSnapshot[] = everyone,
  rotationCounter = 0,
) {
  return selectAccounts(snapshot(accounts), {
    sessionKey: `session-${model}`,
    model,
    keyScope: { kind: "accounts", accountIds: accounts.map((entry) => entry.id) },
    rotationCounter,
  })
}

function chosen(result: ReturnType<typeof selectFor>): readonly string[] {
  return result.ok ? ids(result.candidates) : []
}

describe("the Claude subscription family", () => {
  test("is declared by the anthropic-oauth provider", () => {
    expect(CLAUDE).toBeDefined()
  })

  const family = CLAUDE ?? { patterns: [] }
  for (const name of [
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-opus-5-5[1m]",
    "claude-haiku-4-5-20251001",
    "opus",
    "sonnet",
    "haiku",
    "fable",
    "best",
    "default",
    "opusplan",
    "opus[1m]",
    "sonnet[1m]",
  ]) {
    test(`admits ${name}`, () => expect(inModelFamily(family, name)).toBe(true))
  }

  for (const name of ["gpt-5.5", "glm-5.3", "k3", "MiniMax-M3", "qwen3.8-max", "Opus", "opus-x"]) {
    test(`refuses ${name}`, () => expect(inModelFamily(family, name)).toBe(false))
  }

  test("the ChatGPT/Codex driver declares its family", () => {
    expect(providerModelFamily("openai-oauth")).toBeDefined()
    expect(inModelFamily(CODEX, "gpt-6-sol")).toBe(true)
    expect(inModelFamily(CODEX, "claude-opus-5-5")).toBe(false)
    expect(inModelFamily(CODEX, "glm-5.3")).toBe(false)
  })

  test("providers that may serve anything declare no family", () => {
    for (const id of ["zai", "openrouter", "openai-compatible", "anthropic-api"] as const) {
      expect(providerModelFamily(id)).toBeUndefined()
    }
  })
})

describe("a mixed key picks the vendor by model name", () => {
  test("gpt-5.5 never selects a Claude subscription", () => {
    const result = selectFor("gpt-5.5")
    expect(chosen(result)).not.toContain("claude-1")
    expect(chosen(result)).not.toContain("claude-2")
    expect(chosen(result)[0]).toBe("codex")
  })

  test("glm-5.3 never selects the ChatGPT subscription or a Claude one", () => {
    const picked = chosen(selectFor("glm-5.3"))
    expect(picked).not.toContain("codex")
    expect(picked).not.toContain("claude-1")
    expect([...picked].sort()).toEqual(["minimax", "zai"])
  })

  test("claude-opus-5 goes to Claude first; the alias-only accounts are a failover tail", () => {
    // Round-robin with a counter that would rotate an aliased account to the head.
    for (let counter = 0; counter < everyone.length; counter += 1) {
      const result = selectFor("claude-opus-5", everyone, counter)
      expect(chosen(result).slice(0, 2).sort()).toEqual(["claude-1", "claude-2"])
      expect(chosen(result).slice(2).sort()).toEqual(["minimax", "zai"])
    }
  })

  test("the deferral is recorded on the decision", () => {
    const result = selectFor("claude-opus-5")
    const notes = result.decision.groups.flatMap((group) => group.notes)
    const deferred = notes.find((note) => note.kind === "aliased-deferred")
    expect(deferred?.kind === "aliased-deferred" ? [...deferred.accountIds].sort() : []).toEqual([
      "minimax",
      "zai",
    ])
  })

  test("the native name goes upstream unchanged; the tail carries its own rename", () => {
    const result = selectFor("claude-opus-5")
    if (!result.ok) throw new Error("expected candidates")
    const byId = new Map(result.candidates.map((entry) => [entry.account.id, entry]))
    expect(byId.get("claude-1")?.upstreamModel).toBe("claude-opus-5")
    expect(byId.get("zai")?.upstreamModel).toBe("glm-5.2")
  })

  test("with every Claude account out, the alias tail still serves", () => {
    const out = claude.map((entry) => ({ ...entry, status: "disabled" as const }))
    const picked = chosen(selectFor("claude-opus-5", [...out, codex, zai, minimax]))
    expect([...picked].sort()).toEqual(["minimax", "zai"])
  })

  test("native-first holds across pools: a native in the second pool beats an alias in the first", () => {
    const result = selectAccounts(
      snapshot(everyone, [
        pool("cn", ["zai", "minimax"]),
        pool("claude", ["claude-1", "claude-2"]),
      ]),
      {
        sessionKey: "s",
        model: "claude-opus-5",
        keyScope: { kind: "pools", poolIds: ["cn", "claude"] },
      },
    )
    expect(chosen(result).slice(0, 2).sort()).toEqual(["claude-1", "claude-2"])
    expect(chosen(result).slice(2).sort()).toEqual(["minimax", "zai"])
  })

  test("a session bound to an aliased account stays on it — the binding is truth", () => {
    const result = selectAccounts(snapshot(everyone), {
      sessionKey: "s",
      model: "claude-opus-5",
      keyScope: { kind: "accounts", accountIds: everyone.map((entry) => entry.id) },
      binding: { accountId: "zai" },
    })
    expect(chosen(result)[0]).toBe("zai")
  })
})

describe("the Chinese-only key keeps working", () => {
  test("claude-opus-5 still routes through the alias when nothing native is in scope", () => {
    const result = selectFor("claude-opus-5", [zai, minimax])
    expect([...chosen(result)].sort()).toEqual(["minimax", "zai"])
    if (!result.ok) throw new Error("expected candidates")
    expect(result.candidates.map((entry) => entry.upstreamModel)).toEqual(["glm-5.2", "glm-5.2"])
    expect(result.decision.groups.flatMap((group) => group.notes)).not.toContainEqual(
      expect.objectContaining({ kind: "aliased-deferred" }),
    )
  })
})

describe("explicit supportedModels wins over the family", () => {
  test("a declared list replaces the family in both directions", () => {
    const narrowed = claudeSub("claude-x", { supportedModels: ["house-model"] })
    expect(resolveModel(narrowed, "house-model").supported).toBe(true)
    expect(resolveModel(narrowed, "claude-opus-5").supported).toBe(false)
  })

  test("an empty declared list is no declaration: the family still applies", () => {
    const empty = claudeSub("claude-x", { supportedModels: [] })
    expect(resolveModel(empty, "claude-opus-5").supported).toBe(true)
    expect(resolveModel(empty, "gpt-5.5").supported).toBe(false)
  })

  test("the family is checked after the alias map, on the upstream-side name", () => {
    const renamed = claudeSub("claude-x", { modelAliases: { big: "claude-opus-5" } })
    expect(resolveModel(renamed, "big")).toEqual({
      upstreamModel: "claude-opus-5",
      supported: true,
      aliased: true,
    })
  })
})

describe("nothing in scope serves the model", () => {
  test("the error names the model and every account, as a client change", () => {
    const result = selectFor("glm-5.3", [...claude, codex])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(503)
    expect(result.error.message).toBe(
      'no account serves model "glm-5.3" — a client change (3 accounts in scope: claude-1, claude-2, codex)',
    )
  })

  test("a mixed cause keeps the recoverable lead and still names the unsupported ones", () => {
    const cooling = { ...codex, status: "cooling_down" as const }
    const result = selectFor("gpt-5.5", [...claude, cooling])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(429)
    expect(result.error.message).toContain("2 more do not serve this model")
  })
})

describe("a session bound to an account that cannot serve the model", () => {
  // Prod, 2026-10-04: a `k3` conversation landed on a Claude subscription, the attempt failed, the
  // account went into a recovery probe — and every later turn was told to wait 429 for "settling a
  // recovery probe" on an account that will never serve `k3`. Unsupported outranks every clock.
  const settling = claudeSub("claude-1", {
    status: "cooling_down",
    health: {
      consecutiveFailures: 1,
      inFlight: 0,
      recentTokens: 0,
      cooldownUntil: at(-1_000),
      probeHeldUntil: at(20_000),
    },
  })
  const cooling = claudeSub("claude-2", {
    status: "cooling_down",
    health: { consecutiveFailures: 1, inFlight: 0, recentTokens: 0, cooldownUntil: at(60_000) },
  })

  for (const bound of [settling, cooling]) {
    test(`${bound.id} is invalidated, not blocked, and the request routes elsewhere`, () => {
      const accounts = [bound, zai]
      const result = selectAccounts(snapshot(accounts), {
        sessionKey: "s",
        model: "k3",
        keyScope: { kind: "accounts", accountIds: accounts.map((entry) => entry.id) },
        binding: { accountId: bound.id },
      })
      expect(result.decision.binding).toEqual({
        state: "invalidated",
        accountId: bound.id,
        reason: "model-unsupported",
      })
      expect(chosen(result)).toEqual(["zai"])
    })
  }

  test("an unservable account is reported as model-unsupported, never as cooling down", () => {
    const result = selectFor("k3", [settling, cooling])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.status).toBe(503)
    expect(result.decision.rejected.map((entry) => entry.reason)).toEqual([
      "model-unsupported",
      "model-unsupported",
    ])
  })
})
