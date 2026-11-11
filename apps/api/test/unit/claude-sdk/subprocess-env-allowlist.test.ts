import { describe, expect, test } from "bun:test"
import { ENV_FIELDS } from "../../../src/config/env"
import {
  ALLOWED_ENV_NAMES,
  STRIPPED_ENV_NAMES,
  subprocessEnv,
} from "../../../src/providers/claude-sdk/env"

/**
 * 101 finding 05.3: the subprocess environment was a strip list, and it passed
 * `USAGE_REPORT_DISCORD_WEBHOOK_URL` (a credential) and every operator-level secret it did not
 * name. It is an allowlist now; these assert the drift-proof half — every variable the router's
 * own env schema reads is absent from every `claude` child, whatever is added to the schema later.
 */

describe("the claude subprocess environment is an allowlist", () => {
  test("the Discord webhook URL is not inherited (prod gap)", () => {
    const env = subprocessEnv({
      configDir: "/data/claude/a",
      inherited: { USAGE_REPORT_DISCORD_WEBHOOK_URL: "https://discord.example/hook", PATH: "/bin" },
    })
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CONFIG_DIR: "/data/claude/a" })
    expect(STRIPPED_ENV_NAMES).toContain("USAGE_REPORT_DISCORD_WEBHOOK_URL")
  })

  test("no variable the router's env schema reads reaches the child", () => {
    const names = Object.keys(ENV_FIELDS)
    expect(names.length).toBeGreaterThan(10)
    const inherited = Object.fromEntries(names.map((name) => [name, "router-config-value"]))
    const env = subprocessEnv({ configDir: "/data/claude/a", inherited })
    for (const name of names) if (name !== "CLAUDE_CONFIG_DIR") expect(env).not.toHaveProperty(name)
  })

  test("unlisted operator secrets are dropped by default", () => {
    const env = subprocessEnv({
      configDir: "/data/claude/a",
      inherited: {
        PGPASSWORD: "x",
        GITHUB_TOKEN: "x",
        OPENAI_API_KEY: "x",
        NODE_OPTIONS: "--require /tmp/evil.js",
        BUN_OPTIONS: "x",
        LD_PRELOAD: "/tmp/evil.so",
        HOME: "/home/router",
      },
    })
    expect(env).toEqual({ HOME: "/home/router", CLAUDE_CONFIG_DIR: "/data/claude/a" })
  })

  test("what the binary, its runtime, locale, CA bundle and egress proxy need survives", () => {
    const inherited = Object.fromEntries(ALLOWED_ENV_NAMES.map((name) => [name, `v-${name}`]))
    const env = subprocessEnv({
      configDir: "/data/claude/a",
      inherited: { ...inherited, LC_ALL: "C.UTF-8", LC_CTYPE: "C.UTF-8" },
    })
    for (const name of ALLOWED_ENV_NAMES) expect(env[name]).toBe(`v-${name}`)
    expect(env.LC_ALL).toBe("C.UTF-8")
    expect(env.LC_CTYPE).toBe("C.UTF-8")
  })

  test("an inherited CLAUDE_CONFIG_DIR never wins over the Account's", () => {
    const env = subprocessEnv({
      configDir: "/data/claude/a",
      inherited: { CLAUDE_CONFIG_DIR: "/data/claude/other" },
    })
    expect(env.CLAUDE_CONFIG_DIR).toBe("/data/claude/a")
  })
})
