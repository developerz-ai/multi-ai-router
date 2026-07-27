import { afterEach, describe, expect, test } from "bun:test"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { render } from "solid-js/web"
import type { ApiKeyView, PoolView } from "../../src/lib/api/types"
import { useCreatePool, useDeletePool, usePools, useUpdatePool } from "../../src/lib/queries/pools"
import { queryKeys } from "../../src/lib/queries/query-keys"
import {
  useCreateKey,
  useDeleteKey,
  useKeys,
  useRevokeKey,
  useUpdateKey,
} from "../../src/lib/queries/router-keys"

/**
 * Mutations here never touch the DOM — what they own is the query cache. A
 * mutation whose `onSuccess` forgets to invalidate is invisible in a component
 * test that only checks *this* render's props; the list query underneath goes
 * stale and nothing in the render tree points at why. This is the class of bug
 * that shipped once already (pool `weight`/`priority` silently discarded on
 * edit, Session 59) — the fix was in two places (the request body *and* the
 * cache), and only a test that drives the real hook against a real
 * `QueryClient` and re-reads the list catches a regression in either half.
 *
 * `usePools`/`useKeys`/the mutation hooks all need a reactive owner (Solid's
 * `useQuery`/`useMutation` register effects), so each case mounts a tiny
 * harness component instead of calling the hooks directly — same shape as
 * `KeysRoute.test.tsx`, minus the route.
 */

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20))
}

function mountHarness(client: QueryClient, ui: () => unknown) {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => <QueryClientProvider client={client}>{ui() as never}</QueryClientProvider>,
    container,
  )
  return {
    dispose: () => {
      dispose()
      container.remove()
    },
  }
}

function newClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } })
}

function poolRow(overrides: Partial<PoolView> = {}): PoolView {
  return {
    id: "pool-1",
    name: "default",
    policy: "round-robin",
    overflowAccountId: null,
    members: [
      {
        accountId: "acct-1",
        label: "claude-1",
        provider: "anthropic",
        status: "active",
        weight: 1,
        priority: 1,
      },
    ],
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

function keyRow(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: "key-1",
    name: "ci-runner",
    prefix: "mar_live_9f2c",
    scope: { kind: "all", poolIds: [], accountIds: [] },
    rateLimit: null,
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

describe("pool mutations invalidate the pools cache", () => {
  test("update refetches the list, so an edited weight is not left stale", async () => {
    const calls: string[] = []
    // First GET answers with weight 1; every GET after the PATCH answers with
    // weight 9 — a stand-in for the server persisting the edit. If `useUpdatePool`
    // stopped invalidating `queryKeys.pools.root()`, the cache would keep
    // serving the first response and this assertion would see 1 forever.
    let patched = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url}`)
      if (method === "PATCH") {
        patched = true
        return new Response(
          JSON.stringify(
            poolRow({
              members: [
                {
                  ...poolRow().members[0],
                  weight: 9,
                  priority: 1,
                  accountId: "acct-1",
                  label: "claude-1",
                  provider: "anthropic",
                  status: "active",
                },
              ],
            }),
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        )
      }
      const weight = patched ? 9 : 1
      return new Response(
        JSON.stringify([
          poolRow({
            members: [
              {
                accountId: "acct-1",
                label: "claude-1",
                provider: "anthropic",
                status: "active",
                weight,
                priority: 1,
              },
            ],
          }),
        ]),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as typeof fetch

    const client = newClient()
    let update: ReturnType<typeof useUpdatePool> | undefined
    function Harness() {
      usePools()
      update = useUpdatePool()
      return null
    }
    const { dispose } = mountHarness(client, () => <Harness />)
    try {
      await settle()
      expect(
        (client.getQueryData(queryKeys.pools.list()) as PoolView[])[0]?.members[0]?.weight,
      ).toBe(1)

      update?.mutate({
        id: "pool-1",
        patch: { members: [{ accountId: "acct-1", weight: 9, priority: 1 }] },
      })
      await settle()

      expect(calls).toContain("PATCH /api/admin/pools/pool-1")
      // A second GET landing at all proves invalidation actually fired.
      expect(calls.filter((c) => c.startsWith("GET /api/admin/pools")).length).toBeGreaterThan(1)
      expect(
        (client.getQueryData(queryKeys.pools.list()) as PoolView[])[0]?.members[0]?.weight,
      ).toBe(9)
    } finally {
      dispose()
    }
  })

  test("create invalidates the pools list", async () => {
    const calls: string[] = []
    let created = false
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url}`)
      if (method === "POST") {
        created = true
        return new Response(JSON.stringify(poolRow({ id: "pool-2", name: "overflow" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return new Response(
        JSON.stringify(
          created ? [poolRow(), poolRow({ id: "pool-2", name: "overflow" })] : [poolRow()],
        ),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      )
    }) as typeof fetch

    const client = newClient()
    let create: ReturnType<typeof useCreatePool> | undefined
    function Harness() {
      usePools()
      create = useCreatePool()
      return null
    }
    const { dispose } = mountHarness(client, () => <Harness />)
    try {
      await settle()
      expect((client.getQueryData(queryKeys.pools.list()) as PoolView[]).length).toBe(1)

      create?.mutate({ name: "overflow" })
      await settle()

      expect((client.getQueryData(queryKeys.pools.list()) as PoolView[]).length).toBe(2)
    } finally {
      dispose()
    }
  })

  test("delete invalidates both pools and keys — a key can be scoped to the deleted pool", async () => {
    const calls: string[] = []
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString()
      const method = init?.method ?? "GET"
      calls.push(`${method} ${url}`)
      if (method === "DELETE")
        return new Response(JSON.stringify({ deleted: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      if (url.includes("/pools"))
        return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
      if (url.includes("/keys"))
        return new Response(JSON.stringify([keyRow()]), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    }) as typeof fetch

    const client = newClient()
    let del: ReturnType<typeof useDeletePool> | undefined
    function Harness() {
      usePools()
      useKeys()
      del = useDeletePool()
      return null
    }
    const { dispose } = mountHarness(client, () => <Harness />)
    try {
      await settle()
      const poolsBefore = calls.filter((c) => c.startsWith("GET") && c.includes("/pools")).length
      const keysBefore = calls.filter((c) => c.startsWith("GET") && c.includes("/keys")).length

      del?.mutate("pool-1")
      await settle()

      expect(calls).toContain("DELETE /api/admin/pools/pool-1")
      expect(
        calls.filter((c) => c.startsWith("GET") && c.includes("/pools")).length,
      ).toBeGreaterThan(poolsBefore)
      expect(
        calls.filter((c) => c.startsWith("GET") && c.includes("/keys")).length,
      ).toBeGreaterThan(keysBefore)
    } finally {
      dispose()
    }
  })
})

describe("router key mutations invalidate the keys cache", () => {
  for (const [label, trigger] of [
    [
      "create",
      (h: { create?: ReturnType<typeof useCreateKey> }) => h.create?.mutate({ name: "new-key" }),
    ],
    [
      "update",
      (h: { update?: ReturnType<typeof useUpdateKey> }) =>
        h.update?.mutate({ id: "key-1", patch: { name: "renamed" } }),
    ],
    ["revoke", (h: { revoke?: ReturnType<typeof useRevokeKey> }) => h.revoke?.mutate("key-1")],
    ["delete", (h: { del?: ReturnType<typeof useDeleteKey> }) => h.del?.mutate("key-1")],
  ] as const) {
    test(`${label} triggers a refetch of the keys list`, async () => {
      const calls: string[] = []
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString()
        const method = init?.method ?? "GET"
        calls.push(`${method} ${url}`)
        if (method === "GET")
          return new Response(JSON.stringify([keyRow()]), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        return new Response(JSON.stringify({ ...keyRow(), value: "mar_live_fresh" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }) as typeof fetch

      const client = newClient()
      const handles: {
        create?: ReturnType<typeof useCreateKey>
        update?: ReturnType<typeof useUpdateKey>
        revoke?: ReturnType<typeof useRevokeKey>
        del?: ReturnType<typeof useDeleteKey>
      } = {}
      function Harness() {
        useKeys()
        handles.create = useCreateKey()
        handles.update = useUpdateKey()
        handles.revoke = useRevokeKey()
        handles.del = useDeleteKey()
        return null
      }
      const { dispose } = mountHarness(client, () => <Harness />)
      try {
        await settle()
        const before = calls.filter((c) => c.startsWith("GET")).length

        trigger(handles)
        await settle()

        expect(calls.filter((c) => c.startsWith("GET")).length).toBeGreaterThan(before)
      } finally {
        dispose()
      }
    })
  }
})
