import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { ENV_FIELDS } from "../../src/config/env"

/**
 * `.env.example` is where an operator learns which knobs exist. Nothing held it to the env schema,
 * so `ADMIN_JSON_MAX_BYTES`, `ADMIN_LOGIN_JSON_MAX_BYTES` and `OPENAI_CHAT_THINKING_DEFAULT_MODELS`
 * were parsed at boot and documented in the spec but absent from the file. Both directions: a
 * schema key must appear (set, or commented out as `# NAME=`), and a name in the file must be one
 * the schema actually reads — a stale entry is a knob that silently does nothing.
 */

const EXAMPLE = readFileSync(
  fileURLToPath(new URL("../../../../.env.example", import.meta.url)),
  "utf8",
)

const ENTRY = /^# ?([A-Z][A-Z0-9_]*)=|^([A-Z][A-Z0-9_]*)=/gm

function exampleNames(): ReadonlySet<string> {
  return new Set([...EXAMPLE.matchAll(ENTRY)].map((match) => match[1] ?? match[2] ?? ""))
}

describe(".env.example", () => {
  test("lists every variable the env schema reads", () => {
    const names = exampleNames()
    expect(Object.keys(ENV_FIELDS).filter((name) => !names.has(name))).toEqual([])
  })

  test("lists no variable the env schema does not read", () => {
    const schema = new Set(Object.keys(ENV_FIELDS))
    expect([...exampleNames()].filter((name) => !schema.has(name))).toEqual([])
  })
})
