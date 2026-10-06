import { describe, expect, test } from "bun:test"
import { createSessionStore, type SessionStore } from "../../../src/providers"
import { hashMessages, readConversation } from "../../../src/providers/claude-sdk/session"
import type {
  SessionCarrier,
  SessionCarryInput,
} from "../../../src/providers/claude-sdk/session-carry"
import { type MemorySessions, memorySessions, messagesBody } from "./fixtures"

/**
 * A turn that failed before it answered is not part of the conversation's lineage.
 *
 * The CLI names its session in `system`/`init` before it knows the window is spent, so a refused
 * attempt still reports a session id (and the synthetic "you've hit your limit" reply's uuid). Were
 * that recorded, the binding would move onto the account that just refused, and its lineage would
 * claim the user's unanswered message as seen — so the client's retry classifies as a `replay` and
 * starts fresh instead of carrying the conversation from where it was answered. Production,
 * 2026-10-06 23:15–23:17: two spent accounts each took the binding in turn, the session was pinned
 * to them (429 "session is bound to account …"), and the turn that finally served started fresh
 * with no carry and no line saying why.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

const opening = messagesBody([{ role: "user", text: "hello" }])
const grown = messagesBody([
  { role: "user", text: "hello" },
  { role: "assistant", text: "hi" },
  { role: "user", text: "and now?" },
])

function hashesOf(body: Uint8Array): string[] {
  const conversation = readConversation(body)
  if (conversation === null) throw new Error("fixture body is unreadable")
  return hashMessages(conversation.messages)
}

function carrierSpy(): SessionCarrier & { readonly calls: SessionCarryInput[] } {
  const calls: SessionCarryInput[] = []
  return {
    calls,
    carry: (input) => {
      calls.push(input)
      return Promise.resolve({ carried: true, bytes: 1 })
    },
  }
}

interface Skip {
  readonly reason: string
  readonly fromAccountId: string
  readonly toAccountId: string
}

function storeWith(repository: MemorySessions, carrier?: SessionCarrier) {
  const skipped: Skip[] = []
  const store = createSessionStore({
    repository,
    now: () => NOW,
    ...(carrier === undefined ? {} : { carrier }),
    onCarrySkipped: (skip) => skipped.push(skip),
  })
  return { store, skipped }
}

function resolveOn(store: SessionStore, accountId: string, body: Uint8Array) {
  return store.resolve({
    apiKeyId: "key-1",
    sessionKey: "conv-1",
    keySource: "header",
    accountId,
    body,
  })
}

/** The first turn, on `acct-1`: answered, binds `sess_1`, whose answer is `uuid-1`. */
function bindOnFirstAccount(store: SessionStore): void {
  const first = resolveOn(store, "acct-1", opening)
  first.remember("sess_1", "uuid-1")
  first.release()
}

describe("a turn that failed before answering", () => {
  test("leaves the binding on the account that answered, so the retry carries from there", async () => {
    const repository = memorySessions()
    const carrier = carrierSpy()
    const { store } = storeWith(repository, carrier)
    bindOnFirstAccount(store)

    // Failover lands on acct-2, whose window turns out spent: the CLI named a session and wrote a
    // synthetic reply, then the attempt failed with nothing on the wire.
    const failed = await resolveOn(store, "acct-2", grown).prepare()
    failed.remember("sess_spent", "uuid-synthetic")
    failed.release("failed")
    await Bun.sleep(0)

    expect(await store.binding("key-1", "conv-1")).toEqual({
      accountId: "acct-1",
      sdkSessionId: "sess_1",
      lineage: { prefixHashes: hashesOf(opening), assistantUuids: ["", "uuid-1"] },
    })
    expect([...repository.rows.values()][0]).toMatchObject({
      accountId: "acct-1",
      sdkSessionId: "sess_1",
      lineageState: { prefixHashes: hashesOf(opening), assistantUuids: ["", "uuid-1"] },
    })

    // The client retries the same message on acct-3: carried from acct-1, never a fresh replay.
    const retry = await resolveOn(store, "acct-3", grown).prepare()
    expect(retry.plan).toEqual({
      kind: "fork",
      sdkSessionId: "sess_1",
      resumeSessionAt: "uuid-1",
      deltaFrom: 2,
      carryFrom: "acct-1",
    })
    expect(carrier.calls.at(-1)).toEqual({
      fromAccountId: "acct-1",
      toAccountId: "acct-3",
      sdkSessionId: "sess_1",
    })
    retry.release()
  })

  test("on the bound account itself keeps the lineage it had, so the retry is not a replay", async () => {
    const { store } = storeWith(memorySessions())
    bindOnFirstAccount(store)

    const failed = resolveOn(store, "acct-1", grown)
    failed.remember("sess_1", "uuid-synthetic")
    failed.release("failed")

    expect(resolveOn(store, "acct-1", grown).plan).toEqual({
      kind: "resume",
      sdkSessionId: "sess_1",
      lineage: "continuation",
      deltaFrom: 2,
    })
  })

  test("binds nothing when it was the conversation's first turn", async () => {
    const repository = memorySessions()
    const { store, skipped } = storeWith(repository, carrierSpy())

    const failed = resolveOn(store, "acct-1", opening)
    failed.remember("sess_spent", "uuid-synthetic")
    failed.release("failed")
    await Bun.sleep(0)

    expect(await store.binding("key-1", "conv-1")).toBeUndefined()
    expect([...repository.rows.values()][0]).toMatchObject({ accountId: null, sdkSessionId: null })

    // The retry elsewhere is a plain first turn — not "bound to acct-1", not a replay.
    const retry = resolveOn(store, "acct-2", opening)
    expect(retry.plan).toEqual({ kind: "fresh", reason: "no-session" })
    expect(skipped).toEqual([])
    retry.release()
  })

  test("that never named a session writes nothing and frees the conversation", () => {
    const repository = memorySessions()
    const { store } = storeWith(repository)

    resolveOn(store, "acct-1", opening).release("failed")

    expect(repository.writes).toHaveLength(0)
    expect(resolveOn(store, "acct-1", opening).plan).toEqual({
      kind: "fresh",
      reason: "no-session",
    })
  })
})

describe("a bound session that starts fresh instead of carrying says why", () => {
  test("a replay of what the bound account already holds", () => {
    const carrier = carrierSpy()
    const { store, skipped } = storeWith(memorySessions(), carrier)
    bindOnFirstAccount(store)

    const turn = resolveOn(store, "acct-2", opening)

    expect(turn.plan).toEqual({ kind: "fresh", reason: "replay" })
    expect(skipped).toEqual([{ reason: "replay", fromAccountId: "acct-1", toAccountId: "acct-2" }])
    expect(carrier.calls).toHaveLength(0)
    turn.release()
  })

  test("a concurrent arrival detached from the running turn", () => {
    const { store, skipped } = storeWith(memorySessions(), carrierSpy())
    bindOnFirstAccount(store)

    const owner = resolveOn(store, "acct-2", grown)
    const detached = resolveOn(store, "acct-2", grown)

    expect(detached.plan).toEqual({ kind: "fresh", reason: "session-busy" })
    expect(skipped).toEqual([
      { reason: "session-busy", fromAccountId: "acct-1", toAccountId: "acct-2" },
    ])
    owner.release()
    detached.release()
  })

  test("carrying is switched off", async () => {
    const { store, skipped } = storeWith(memorySessions())
    bindOnFirstAccount(store)

    const turn = await resolveOn(store, "acct-2", grown).prepare()

    expect(turn.plan).toEqual({ kind: "fresh", reason: "carry-failed" })
    expect(skipped).toEqual([
      { reason: "carry-disabled", fromAccountId: "acct-1", toAccountId: "acct-2" },
    ])
    turn.release()
  })

  test("nothing is reported when the turn carries, or stays on its own account", async () => {
    const { store, skipped } = storeWith(memorySessions(), carrierSpy())
    bindOnFirstAccount(store)

    const carried = await resolveOn(store, "acct-2", grown).prepare()
    carried.release()
    const home = await resolveOn(store, "acct-1", opening).prepare()
    home.release()

    expect(carried.plan.kind).toBe("fork")
    expect(home.plan).toEqual({ kind: "fresh", reason: "replay" })
    expect(skipped).toEqual([])
  })
})
