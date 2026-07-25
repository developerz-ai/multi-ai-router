import { describe, expect, test } from "bun:test"
import { queryKeys } from "../../src/lib/queries/query-keys"

// The invariant that makes invalidation work: **every key beneath a resource
// starts with that resource's `root`.** `invalidateQueries({ queryKey: root })`
// matches by prefix, so a key that does not share the prefix is a table that
// silently stays stale after a mutation.

const startsWith = (key: readonly unknown[], prefix: readonly unknown[]): boolean =>
  prefix.every((segment, index) => key[index] === segment)

const auditQuery = { limit: 50, kind: null, subjectId: null }

describe("queryKeys", () => {
  test("every accounts key is prefixed by the accounts root", () => {
    const root = queryKeys.accounts.root()
    expect(startsWith(queryKeys.accounts.list({}), root)).toBe(true)
    expect(startsWith(queryKeys.accounts.list({ status: "exhausted" }), root)).toBe(true)
    expect(startsWith(queryKeys.accounts.detail("id"), root)).toBe(true)
    expect(startsWith(queryKeys.accounts.recheck("id"), root)).toBe(true)
  })

  test("every pools, keys, providers and usage key is prefixed by its root", () => {
    expect(startsWith(queryKeys.pools.list(), queryKeys.pools.root())).toBe(true)
    expect(startsWith(queryKeys.pools.detail("id"), queryKeys.pools.root())).toBe(true)
    expect(startsWith(queryKeys.keys.list(), queryKeys.keys.root())).toBe(true)
    expect(startsWith(queryKeys.keys.detail("id"), queryKeys.keys.root())).toBe(true)
    expect(startsWith(queryKeys.providers.list(), queryKeys.providers.root())).toBe(true)
    expect(startsWith(queryKeys.usage.summary("7d"), queryKeys.usage.root())).toBe(true)
  })

  test("every settings, tasks and audit key is prefixed by its root", () => {
    // The price mutation invalidates the settings root; a detail key that did not share the
    // prefix would leave the table showing the rates it had before the save.
    expect(startsWith(queryKeys.settings.detail(), queryKeys.settings.root())).toBe(true)
    expect(startsWith(queryKeys.tasks.list(), queryKeys.tasks.root())).toBe(true)
    expect(startsWith(queryKeys.audit.list(auditQuery), queryKeys.audit.root())).toBe(true)
  })

  test("the resource roots are disjoint, so one mutation cannot invalidate another's cache", () => {
    const roots = [
      queryKeys.accounts.root()[0],
      queryKeys.pools.root()[0],
      queryKeys.keys.root()[0],
      queryKeys.providers.root()[0],
      queryKeys.usage.root()[0],
      queryKeys.settings.root()[0],
      queryKeys.tasks.root()[0],
      queryKeys.audit.root()[0],
      queryKeys.session()[0],
    ]
    expect(new Set(roots).size).toBe(roots.length)
  })

  test("a filtered list is keyed by its filter, not by object identity", () => {
    expect(queryKeys.accounts.list({ status: "active" })).toEqual(
      queryKeys.accounts.list({ status: "active" }),
    )
    expect(queryKeys.accounts.list({ status: "active" })).not.toEqual(
      queryKeys.accounts.list({ status: "disabled" }),
    )
  })

  test("an empty filter and an explicit-undefined filter are the same cache entry", () => {
    expect(queryKeys.accounts.list({})).toEqual(
      queryKeys.accounts.list({ status: undefined, provider: undefined }),
    )
  })

  test("an audit page is keyed by every part of its query, so a filter change is a new read", () => {
    expect(queryKeys.audit.list(auditQuery)).toEqual(queryKeys.audit.list({ ...auditQuery }))
    expect(queryKeys.audit.list(auditQuery)).not.toEqual(
      queryKeys.audit.list({ ...auditQuery, limit: 200 }),
    )
    expect(queryKeys.audit.list(auditQuery)).not.toEqual(
      queryKeys.audit.list({ ...auditQuery, kind: "key.viewed" }),
    )
  })
})
