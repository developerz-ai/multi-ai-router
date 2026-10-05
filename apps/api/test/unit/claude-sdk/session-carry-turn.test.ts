import { describe, expect, test } from "bun:test"
import { createSessionStore, type SessionStore } from "../../../src/providers"
import type {
  SessionCarrier,
  SessionCarryInput,
  SessionCarryOutcome,
} from "../../../src/providers/claude-sdk/session-carry"
import { type MemorySessions, memorySessions, messagesBody } from "./fixtures"

/**
 * A conversation whose next turn lands on a different subscription than the one it is bound to
 * (docs/idea/11-anthropic-agent-sdk.md §4, "Carrying a session to another Account").
 *
 * The local analogue is `/login` mid-session: the transcript stays, the credential beside it
 * changes, and the conversation continues. Here the transcript has to be copied into the other
 * Account's config directory first, so the plan says where it comes from and `prepare` either
 * carries it or turns the turn fresh — never a resume of an id the new Account has never seen.
 */

const NOW = new Date("2026-01-01T12:00:00.000Z")

const opening = messagesBody([{ role: "user", text: "hello" }])
const grown = messagesBody([
  { role: "user", text: "hello" },
  { role: "assistant", text: "hi" },
  { role: "user", text: "and now?" },
])

function fakeCarrier(outcome: SessionCarryOutcome): SessionCarrier & {
  readonly calls: SessionCarryInput[]
} {
  const calls: SessionCarryInput[] = []
  return {
    calls,
    carry: (input) => {
      calls.push(input)
      return Promise.resolve(outcome)
    },
  }
}

function storeWith(repository: MemorySessions, carrier?: SessionCarrier) {
  const reported: unknown[] = []
  const store = createSessionStore({
    repository,
    now: () => NOW,
    ...(carrier === undefined ? {} : { carrier }),
    onCarry: (outcome) => reported.push(outcome),
  })
  return { store, reported }
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

/** The first turn, on `acct-1`: binds `sess_1`, whose answer is `uuid-1`. */
function bindOnFirstAccount(store: SessionStore): void {
  const first = resolveOn(store, "acct-1", opening)
  first.remember("sess_1", "uuid-1")
  first.release()
}

describe("a turn that lands off its bound account", () => {
  test("carries the transcript, then forks it at the last answer the binding recorded", async () => {
    const repository = memorySessions()
    const carrier = fakeCarrier({ carried: true, bytes: 42 })
    const { store, reported } = storeWith(repository, carrier)
    bindOnFirstAccount(store)

    const turn = await resolveOn(store, "acct-2", grown).prepare()

    expect(carrier.calls).toEqual([
      { fromAccountId: "acct-1", toAccountId: "acct-2", sdkSessionId: "sess_1" },
    ])
    expect(turn.plan).toEqual({
      kind: "fork",
      sdkSessionId: "sess_1",
      resumeSessionAt: "uuid-1",
      deltaFrom: 2,
      carryFrom: "acct-1",
    })
    expect(reported).toEqual([
      { carried: true, bytes: 42, fromAccountId: "acct-1", toAccountId: "acct-2" },
    ])

    // The binding moves only once the new account has answered — through the turn's own write,
    // naming the fork's new session id.
    turn.remember("sess_1b", "uuid-2")
    turn.release()
    await Promise.resolve()
    const row = [...repository.rows.values()][0]
    expect(row).toMatchObject({ accountId: "acct-2", sdkSessionId: "sess_1b" })
    // The carried file is the same transcript, so the earlier answer's uuid still names a message
    // in it — an undo after the move can still fork there.
    expect(row?.lineageState?.assistantUuids).toEqual(["", "uuid-1", "", "uuid-2"])
  })

  test("a carry that fails starts fresh, and keeps no uuid from the transcript it never got", async () => {
    const repository = memorySessions()
    const carrier = fakeCarrier({ carried: false, reason: "not-found" })
    const { store, reported } = storeWith(repository, carrier)
    bindOnFirstAccount(store)

    const turn = await resolveOn(store, "acct-2", grown).prepare()

    expect(turn.plan).toEqual({ kind: "fresh", reason: "carry-failed" })
    expect(reported).toEqual([
      { carried: false, reason: "not-found", fromAccountId: "acct-1", toAccountId: "acct-2" },
    ])

    turn.remember("sess_2", "uuid-2")
    turn.release()
    await Promise.resolve()
    const row = [...repository.rows.values()][0]
    expect(row).toMatchObject({ accountId: "acct-2", sdkSessionId: "sess_2" })
    expect(row?.lineageState?.assistantUuids).toEqual(["", "", "", "uuid-2"])
  })

  test("the fresh fallback still owns the conversation: a concurrent arrival detaches", async () => {
    const carrier = fakeCarrier({ carried: false, reason: "io-error" })
    const { store } = storeWith(memorySessions(), carrier)
    bindOnFirstAccount(store)

    const turn = await resolveOn(store, "acct-2", grown).prepare()
    const concurrent = resolveOn(store, "acct-2", grown)

    expect(concurrent.plan).toEqual({ kind: "fresh", reason: "session-busy" })
    turn.release()
    concurrent.release()
  })

  test("a detached turn never carries anything", async () => {
    const carrier = fakeCarrier({ carried: true, bytes: 1 })
    const { store } = storeWith(memorySessions(), carrier)
    bindOnFirstAccount(store)

    const owner = resolveOn(store, "acct-2", grown)
    const detached = await resolveOn(store, "acct-2", grown).prepare()

    expect(detached.plan).toEqual({ kind: "fresh", reason: "session-busy" })
    expect(carrier.calls).toHaveLength(0)
    owner.release()
    detached.release()
  })

  test("a turn on its own account carries nothing", async () => {
    const carrier = fakeCarrier({ carried: true, bytes: 1 })
    const { store } = storeWith(memorySessions(), carrier)
    bindOnFirstAccount(store)

    const turn = await resolveOn(store, "acct-1", grown).prepare()

    expect(turn.plan).toEqual({
      kind: "resume",
      sdkSessionId: "sess_1",
      lineage: "continuation",
      deltaFrom: 2,
    })
    expect(carrier.calls).toHaveLength(0)
    turn.release()
  })

  test("a session the SDK already disowned is never carried", async () => {
    const carrier = fakeCarrier({ carried: true, bytes: 1 })
    const { store } = storeWith(memorySessions(), carrier)
    bindOnFirstAccount(store)

    const turn = await store
      .resolve({
        apiKeyId: "key-1",
        sessionKey: "conv-1",
        keySource: "header",
        accountId: "acct-2",
        body: grown,
        sessionGone: true,
      })
      .prepare()

    expect(turn.plan).toEqual({ kind: "fresh", reason: "session-gone" })
    expect(carrier.calls).toHaveLength(0)
    turn.release()
  })
})
