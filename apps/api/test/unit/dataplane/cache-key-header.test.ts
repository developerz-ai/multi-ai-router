import { describe, expect, test } from "bun:test"
import { CODEX_RESPONSES_EGRESS } from "../../../src/providers"
import {
  cacheKeyHeader,
  effectiveCacheKey,
  sessionCacheKey,
} from "../../../src/services/dataplane/egress/cache-key-header"
import { DEFAULT_RESPONSES_EGRESS } from "../../../src/services/translate"

const NAME = "session-id"

describe("cacheKeyHeader", () => {
  test("a surface that declares no header gets none, whatever the request carries", () => {
    expect(
      cacheKeyHeader(DEFAULT_RESPONSES_EGRESS.cacheKeyHeader, { kind: "translated", key: "k" }),
    ).toBeUndefined()
    expect(
      cacheKeyHeader(DEFAULT_RESPONSES_EGRESS.cacheKeyHeader, {
        kind: "relay",
        client: new Headers({ [NAME]: "k" }),
      }),
    ).toBeUndefined()
  })

  test("the Codex surface declares session-id, the header codex-rs sends its cache key under", () => {
    expect(CODEX_RESPONSES_EGRESS.cacheKeyHeader).toBe(NAME)
  })

  test("translated: the caller's prompt_cache_key, or nothing", () => {
    expect(cacheKeyHeader(NAME, { kind: "translated", key: "turn-1" })).toEqual([NAME, "turn-1"])
    expect(cacheKeyHeader(NAME, { kind: "translated", key: undefined })).toBeUndefined()
    expect(cacheKeyHeader(NAME, { kind: "translated", key: "  " })).toBeUndefined()
  })

  test("translated: a key no header can carry is not sent", () => {
    expect(cacheKeyHeader(NAME, { kind: "translated", key: "a\nb" })).toBeUndefined()
    expect(cacheKeyHeader(NAME, { kind: "translated", key: "naïve" })).toBeUndefined()
  })

  test("relay: the client's own header of that name, or nothing", () => {
    const client = new Headers({ "Session-Id": "thread-77", "x-session-id": "other" })
    expect(cacheKeyHeader(NAME, { kind: "relay", client })).toEqual([NAME, "thread-77"])
    expect(
      cacheKeyHeader(NAME, { kind: "relay", client: new Headers({ "x-session-id": "other" }) }),
    ).toBeUndefined()
  })
})

describe("sessionCacheKey", () => {
  test("stable per session, distinct across sessions and router keys", () => {
    const one = sessionCacheKey("key-1", "fp_abc", "fingerprint")
    expect(one).toBe(sessionCacheKey("key-1", "fp_abc", "fingerprint"))
    expect(one).not.toBe(sessionCacheKey("key-1", "fp_xyz", "fingerprint"))
    expect(one).not.toBe(sessionCacheKey("key-2", "fp_abc", "fingerprint"))
    expect(one).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  })

  test("a client session header is never sent verbatim", () => {
    expect(sessionCacheKey("key-1", "conversation-42", "header")).not.toContain("conversation-42")
  })

  test("an unbound session, fresh per request, sends no key", () => {
    expect(sessionCacheKey("key-1", "unbound_1", "unbound")).toBeUndefined()
  })
})

describe("effectiveCacheKey", () => {
  test("the caller's key wins; empty or blank falls back to the router's", () => {
    expect(effectiveCacheKey("conv-1", "router")).toBe("conv-1")
    for (const none of [undefined, null, "", "  ", 7]) {
      expect(effectiveCacheKey(none, "router")).toBe("router")
    }
    expect(effectiveCacheKey(undefined, undefined)).toBeUndefined()
  })
})
