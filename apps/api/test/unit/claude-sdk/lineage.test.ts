import { describe, expect, test } from "bun:test"
import {
  carriedPlan,
  classifyLineage,
  hashMessages,
  type LineageClass,
  readConversation,
  resolveLineage,
  type SessionPlan,
  sessionFingerprint,
} from "../../../src/providers"
import { messagesBody, toolResultBody } from "./fixtures"

/**
 * The seven lineage classes and the never-resume rules
 * (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * Every one of them is a correctness decision. Getting `continuation` wrong costs a cold prompt
 * cache; getting `replay` or `undo` wrong answers a question the user already took back, or answers
 * the same one twice into one transcript.
 */

const hashes = (...labels: readonly string[]): string[] => labels.map((label) => `h:${label}`)

describe("classifying an incoming conversation against a stored one", () => {
  test("the prefix matches and it grew: a continuation, sending only the delta", () => {
    const overlap = classifyLineage(hashes("a", "b"), hashes("a", "b", "c"))

    expect(overlap.lineage).toBe("continuation")
    expect(overlap.deltaFrom).toBe(2)
  })

  test("an earlier message changed but most survived and it grew: a modified continuation", () => {
    const overlap = classifyLineage(
      hashes("a", "b", "c", "d", "e"),
      hashes("a", "b", "c", "MUTATED", "e", "f"),
    )

    expect(overlap.lineage).toBe("modified-continuation")
    expect(overlap.deltaFrom).toBe(5)
  })

  test("a replaced stored tail is a rewrite, whose delta starts where the histories part", () => {
    // Stored: the turn, its answer, then a hidden suggestion one-shot. Incoming: the real next turn
    // on top of the same answer. The user's message sits *inside* the stored length.
    const overlap = classifyLineage(
      hashes("u1", "a1", "u2", "a2", "suggest"),
      hashes("u1", "a1", "u2", "a2", "real", "reminder"),
    )

    expect(overlap.lineage).toBe("rewrite")
    expect(overlap.deltaFrom).toBe(4)
    expect(overlap.preserved).toBe(4)
  })

  test("a replaced tail of the same length is a rewrite too, not a fresh replay", () => {
    const overlap = classifyLineage(
      hashes("u1", "a1", "u2", "a2", "suggest"),
      hashes("u1", "a1", "u2", "a2", "real"),
    )

    expect(overlap.lineage).toBe("rewrite")
    expect(overlap.deltaFrom).toBe(4)
  })

  test("a client-side compaction is a contiguous stored suffix reappearing after position 0", () => {
    const overlap = classifyLineage(
      hashes("a", "b", "c", "d", "e"),
      hashes("summary", "c", "d", "e"),
    )

    expect(overlap.lineage).toBe("compaction")
    // Everything through the reappearing suffix is already in the session's own transcript.
    expect(overlap.deltaFrom).toBe(4)
  })

  test("a single coincidental match is not a compaction — overlap is positional, not membership", () => {
    const overlap = classifyLineage(hashes("a", "b", "c"), hashes("summary", "c"))

    expect(overlap.lineage).toBe("diverged")
  })

  test("the prefix survives and the conversation shrank: an undo", () => {
    const overlap = classifyLineage(hashes("a", "b", "c", "d"), hashes("a", "b"))

    expect(overlap.lineage).toBe("undo")
    expect(overlap.preserved).toBe(2)
  })

  test("an identical resend is a replay, never a resume", () => {
    const overlap = classifyLineage(hashes("a", "b"), hashes("a", "b"))

    expect(overlap.lineage).toBe("replay")
  })

  test("no overlap at all is divergence", () => {
    expect(classifyLineage(hashes("a", "b"), hashes("x", "y", "z")).lineage).toBe("diverged")
  })

  test("an empty side is divergence rather than an accidental match", () => {
    expect(classifyLineage([], hashes("a")).lineage).toBe("diverged")
    expect(classifyLineage(hashes("a"), []).lineage).toBe("diverged")
  })
})

const stored = (prefixHashes: readonly string[], assistantUuids: readonly string[] = []) => ({
  sdkSessionId: "sess_1",
  lineage: { prefixHashes, assistantUuids },
})

const view = (body: Uint8Array) => {
  const conversation = readConversation(body)
  if (conversation === null) throw new Error("fixture body did not parse")
  return conversation
}

describe("resolving what the SDK launch does with the turn", () => {
  test("a continuation resumes the stored session", () => {
    const first = view(messagesBody([{ role: "user", text: "hello" }]))
    const second = view(
      messagesBody([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
        { role: "user", text: "and now?" },
      ]),
    )

    const plan = resolveLineage({
      session: stored(hashMessages(first.messages)),
      conversation: second,
      keySource: "header",
    })

    expect(plan.kind).toBe("resume")
    if (plan.kind !== "resume") return
    expect(plan.sdkSessionId).toBe("sess_1")
    expect(plan.lineage).toBe("continuation")
    // Index 1 is the session's own answer echoed back; it already holds that.
    expect(plan.deltaFrom).toBe(2)
  })

  test("a trailing assistant message is a prefill, so it is not skipped as an echo", () => {
    const first = view(messagesBody([{ role: "user", text: "hello" }]))
    const prefill = view(
      messagesBody([
        { role: "user", text: "hello" },
        { role: "assistant", text: "Sure," },
      ]),
    )

    const plan = resolveLineage({
      session: stored(hashMessages(first.messages)),
      conversation: prefill,
      keySource: "header",
    })

    expect(plan).toMatchObject({ kind: "resume", deltaFrom: 1 })
  })

  test("a real turn after a hidden one-shot forks at the shared answer and sends the turn", () => {
    const turns = [
      { role: "user", text: "why so slow?" },
      { role: "assistant", text: "the gate" },
    ] as const
    const afterSuggestion = view(
      messagesBody([...turns, { role: "user", text: "[SUGGESTION MODE: predict]" }]),
    )
    const real = view(messagesBody([...turns, { role: "user", text: "keep it under 8gb" }]))

    // The main turn's answer landed at index 1; the one-shot's answer at index 3.
    const plan = resolveLineage({
      session: stored(hashMessages(afterSuggestion.messages), ["", "uuid-answer", "", "uuid-x"]),
      conversation: real,
      keySource: "header",
    })

    expect(plan).toEqual({
      kind: "fork",
      sdkSessionId: "sess_1",
      resumeSessionAt: "uuid-answer",
      deltaFrom: 2,
    })
  })

  test("a rewrite with no uuid to rewind to replays fresh rather than dropping the turn", () => {
    const base = [
      { role: "user", text: "one" },
      { role: "assistant", text: "two" },
    ] as const
    const plan = resolveLineage({
      session: stored(
        hashMessages(view(messagesBody([...base, { role: "user", text: "x" }])).messages),
      ),
      conversation: view(messagesBody([...base, { role: "user", text: "y" }])),
      keySource: "header",
    })

    expect(plan).toEqual({ kind: "fresh", reason: "no-rollback-point" })
  })

  test("an undo forks at the SDK message uuid it rewinds to", () => {
    const long = view(
      messagesBody([
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
        { role: "user", text: "three" },
      ]),
    )
    const shortened = view(
      messagesBody([
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
      ]),
    )

    // Index 1 is the assistant turn; index 3 is where the next answer will land.
    const plan = resolveLineage({
      session: stored(hashMessages(long.messages), ["", "uuid-two", "", "uuid-four"]),
      conversation: shortened,
      keySource: "header",
    })

    expect(plan.kind).toBe("fork")
    if (plan.kind !== "fork") return
    expect(plan.resumeSessionAt).toBe("uuid-two")
    expect(plan.sdkSessionId).toBe("sess_1")
  })

  test("an undo with no uuid to name starts fresh rather than guessing a rollback point", () => {
    const long = view(
      messagesBody([
        { role: "user", text: "one" },
        { role: "assistant", text: "two" },
      ]),
    )
    const shortened = view(messagesBody([{ role: "user", text: "one" }]))

    const plan = resolveLineage({
      session: stored(hashMessages(long.messages)),
      conversation: shortened,
      keySource: "header",
    })

    expect(plan).toEqual({ kind: "fresh", reason: "no-rollback-point" })
  })

  test("an identical resend starts fresh, so the last user message is not answered twice", () => {
    const conversation = view(messagesBody([{ role: "user", text: "hello" }]))

    const plan = resolveLineage({
      session: stored(hashMessages(conversation.messages)),
      conversation,
      keySource: "header",
    })

    expect(plan).toEqual({ kind: "fresh", reason: "replay" })
  })

  test("a headerless turn ending in a tool_result never resumes", () => {
    const conversation = view(toolResultBody([{ role: "user", text: "run the tool" }]))

    expect(
      resolveLineage({
        session: stored(hashMessages(conversation.messages)),
        conversation,
        keySource: "fingerprint",
      }),
    ).toEqual({ kind: "fresh", reason: "tool-result-without-header" })
  })

  test("the same turn with a client-supplied header is free to resume", () => {
    const opening = view(messagesBody([{ role: "user", text: "run the tool" }]))
    const conversation = view(toolResultBody([{ role: "user", text: "run the tool" }]))

    const plan = resolveLineage({
      session: stored(hashMessages(opening.messages)),
      conversation,
      keySource: "header",
    })

    expect(plan.kind).toBe("resume")
  })

  test("a fork or subagent child, and a session the SDK says is gone, never resume", () => {
    const conversation = view(messagesBody([{ role: "user", text: "hello" }]))
    const session = stored(hashMessages(conversation.messages))

    expect(
      resolveLineage({ session, conversation, keySource: "header", forkOrSubagent: true }),
    ).toEqual({ kind: "fresh", reason: "subagent-child" })
    expect(
      resolveLineage({ session, conversation, keySource: "header", sessionGone: true }),
    ).toEqual({ kind: "fresh", reason: "session-gone" })
  })

  test("an unreadable body is a fresh session by name, not an error", () => {
    expect(
      resolveLineage({ session: stored(hashes("a")), conversation: null, keySource: "header" }),
    ).toEqual({ kind: "fresh", reason: "unreadable-body" })
  })
})

describe("reading a request into the lineage view", () => {
  test("a moved cache_control marker does not change a message's hash", () => {
    const plain = readConversation(
      new TextEncoder().encode(
        JSON.stringify({
          messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
        }),
      ),
    )
    const marked = readConversation(
      new TextEncoder().encode(
        JSON.stringify({
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "hello", cache_control: { type: "ephemeral" } }],
            },
          ],
        }),
      ),
    )

    expect(hashMessages(plain?.messages ?? [])).toEqual(hashMessages(marked?.messages ?? []))
  })

  test("reordered JSON keys hash the same, so a re-serializing client is not a divergence", () => {
    const one = readConversation(
      new TextEncoder().encode(
        JSON.stringify({
          messages: [
            { role: "user", content: [{ type: "tool_use", id: "t1", name: "x", input: { a: 1 } }] },
          ],
        }),
      ),
    )
    const other = readConversation(
      new TextEncoder().encode(
        JSON.stringify({
          messages: [
            { role: "user", content: [{ input: { a: 1 }, name: "x", id: "t1", type: "tool_use" }] },
          ],
        }),
      ),
    )

    expect(hashMessages(one?.messages ?? [])).toEqual(hashMessages(other?.messages ?? []))
  })

  test("the same text from a different role is a different message", () => {
    const asUser = view(messagesBody([{ role: "user", text: "hello" }]))
    const asAssistant = view(messagesBody([{ role: "assistant", text: "hello" }]))

    expect(hashMessages(asUser.messages)).not.toEqual(hashMessages(asAssistant.messages))
  })

  test("a body that is not an Anthropic Messages request reads as nothing to key on", () => {
    expect(readConversation(null)).toBeNull()
    expect(readConversation(new Uint8Array(0))).toBeNull()
    expect(readConversation(new TextEncoder().encode("not json"))).toBeNull()
    expect(readConversation(new TextEncoder().encode('{"prompt":"hi"}'))).toBeNull()
  })
})

describe("the headerless fingerprint", () => {
  const seed = {
    apiKeyId: "key-1",
    accountId: "acct-1",
    clientCwd: null,
    firstUserText: "fix the failing test",
  }

  test("the same opening on the same account is the same key", () => {
    expect(sessionFingerprint(seed)).toBe(sessionFingerprint({ ...seed }))
  })

  test("the same opening on another account is a different key — an SDK session is not portable", () => {
    expect(sessionFingerprint(seed)).not.toBe(sessionFingerprint({ ...seed, accountId: "acct-2" }))
  })

  test("two projects opening with the same message are separated by the working directory", () => {
    expect(sessionFingerprint({ ...seed, clientCwd: "/a" })).not.toBe(
      sessionFingerprint({ ...seed, clientCwd: "/b" }),
    )
  })

  test("only the conversation's opening seeds it, so a growing history keeps its key", () => {
    const first = view(messagesBody([{ role: "user", text: "hello" }]))
    const later = view(
      messagesBody([
        { role: "user", text: "hello" },
        { role: "assistant", text: "hi" },
        { role: "user", text: "and now?" },
      ]),
    )

    expect(sessionFingerprint({ ...seed, firstUserText: first.firstUserText })).toBe(
      sessionFingerprint({ ...seed, firstUserText: later.firstUserText }),
    )
  })
})

describe("a plan carried in from another account", () => {
  const resume = (lineage: LineageClass, deltaFrom: number): SessionPlan => ({
    kind: "resume",
    sdkSessionId: "sess_a",
    lineage,
    deltaFrom,
  })

  test("a continuation forks at the last recorded answer, so a failed attempt's tail stays behind", () => {
    expect(carriedPlan(resume("continuation", 4), "acct-a", ["", "uuid-1", "", "uuid-3"])).toEqual({
      kind: "fork",
      sdkSessionId: "sess_a",
      resumeSessionAt: "uuid-3",
      deltaFrom: 4,
      carryFrom: "acct-a",
    })
  })

  test("a continuation with no recorded answer still resumes rather than starting fresh", () => {
    expect(carriedPlan(resume("continuation", 2), "acct-a", ["", ""])).toEqual({
      ...resume("continuation", 2),
      carryFrom: "acct-a",
    })
  })

  test("a compaction keeps its resume: its stored positions name nothing in the incoming messages", () => {
    expect(carriedPlan(resume("compaction", 2), "acct-a", ["", "uuid-1"])).toEqual({
      ...resume("compaction", 2),
      carryFrom: "acct-a",
    })
  })

  test("a fork keeps its own rewind point, and a fresh plan carries nothing", () => {
    const fork: SessionPlan = {
      kind: "fork",
      sdkSessionId: "sess_a",
      resumeSessionAt: "uuid-1",
      deltaFrom: 2,
    }
    expect(carriedPlan(fork, "acct-a", ["", "uuid-1", "", "uuid-3"])).toEqual({
      ...fork,
      carryFrom: "acct-a",
    })
    const fresh: SessionPlan = { kind: "fresh", reason: "diverged" }
    expect(carriedPlan(fresh, "acct-a", ["", "uuid-1"])).toBe(fresh)
  })
})
