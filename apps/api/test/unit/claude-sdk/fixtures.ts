import type { SessionRepository, SessionRow, UpsertSessionInput } from "@multi-ai-router/db"

/**
 * Helpers for the Claude subscription session suites: an in-memory `sessions` table, a request-body
 * builder, and a clock a test drives by hand.
 *
 * The repository double is a real map keyed the way the unique index is — `(apiKeyId, key)` — and
 * it counts its reads, because "one indexed query on a miss and nothing on a hit" is the property
 * the store exists to hold and a call counter is the only way to assert it.
 */

export interface MemorySessions extends SessionRepository {
  /** Reads served. A cache that works leaves this flat across turns of one conversation. */
  readonly reads: number
  readonly writes: readonly UpsertSessionInput[]
  readonly rows: ReadonlyMap<string, SessionRow>
  fail(mode: "read" | "write" | null): void
}

export function memorySessions(seed: readonly UpsertSessionInput[] = []): MemorySessions {
  const rows = new Map<string, SessionRow>()
  let reads = 0
  const writes: UpsertSessionInput[] = []
  let failing: "read" | "write" | null = null

  const put = (input: UpsertSessionInput): SessionRow => {
    const id = `${input.apiKeyId}::${input.key}`
    const previous = rows.get(id)
    const row: SessionRow = {
      id,
      key: input.key,
      apiKeyId: input.apiKeyId,
      accountId: input.accountId === undefined ? (previous?.accountId ?? null) : input.accountId,
      sdkSessionId:
        input.sdkSessionId === undefined ? (previous?.sdkSessionId ?? null) : input.sdkSessionId,
      lineageState:
        input.lineageState === undefined ? (previous?.lineageState ?? null) : input.lineageState,
      fingerprintSource:
        input.fingerprintSource === undefined
          ? (previous?.fingerprintSource ?? null)
          : input.fingerprintSource,
      lastUsedAt: input.lastUsedAt,
      createdAt: previous?.createdAt ?? input.lastUsedAt,
    }
    rows.set(id, row)
    return row
  }

  for (const input of seed) put(input)

  return {
    get reads() {
      return reads
    },
    get writes() {
      return writes
    },
    get rows() {
      return rows
    },

    fail(mode) {
      failing = mode
    },

    findByKey: async (apiKeyId, key) => {
      reads += 1
      if (failing === "read") throw new Error("sessions read failed")
      return rows.get(`${apiKeyId}::${key}`)
    },

    upsert: async (input) => {
      if (failing === "write") throw new Error("sessions write failed")
      writes.push(input)
      return put(input)
    },

    clearAccount: async (accountId) => {
      let cleared = 0
      for (const [id, row] of rows) {
        if (row.accountId !== accountId) continue
        rows.set(id, { ...row, accountId: null, sdkSessionId: null, lineageState: null })
        cleared += 1
      }
      return cleared
    },

    deleteIdleBefore: async () => 0,
  }
}

export interface TurnMessage {
  readonly role: "user" | "assistant"
  readonly text: string
}

/** An Anthropic Messages body, as bytes — what the SDK path is handed. */
export function messagesBody(
  turns: readonly TurnMessage[],
  extra: Record<string, unknown> = {},
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      model: "claude-opus-5",
      max_tokens: 64,
      messages: turns.map((turn) => ({ role: turn.role, content: turn.text })),
      ...extra,
    }),
  )
}

/** A body whose last block is a `tool_result` — the headerless never-resume shape. */
export function toolResultBody(turns: readonly TurnMessage[], toolUseId = "toolu_1"): Uint8Array {
  const messages = [
    ...turns.map((turn) => ({ role: turn.role, content: turn.text })),
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "42" }],
    },
  ]
  return new TextEncoder().encode(
    JSON.stringify({ model: "claude-opus-5", max_tokens: 64, messages }),
  )
}

/** Milliseconds a test moves by hand. Every expiry below is asserted without waiting. */
export function ticker(start = 0): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return {
    now: () => at,
    advance: (ms) => {
      at += ms
    },
  }
}
