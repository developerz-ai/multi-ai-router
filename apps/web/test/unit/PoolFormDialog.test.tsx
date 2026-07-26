import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { CreatePoolInput } from "../../src/lib/api/pools"
import type { AccountView, PoolView } from "../../src/lib/api/types"
import { PoolFormDialog } from "../../src/routes/pools/PoolFormDialog"

/**
 * The overflow is one of the pool's **members**, held back from the policy — never a way out of
 * the pool. Candidates are `pool_members ∩ key_scope` and nothing widens that, so a form that
 * offers a non-member as the overflow is offering the operator a scope leak the API will refuse
 * (`overflow_not_member`, `400`). These assert the form cannot compose that request at all.
 *
 * Mounted through the real `Modal`/`Portal` stack; `dispose` always runs, because `Portal`
 * content lives under a `document.body` shared by every test in this process.
 */
function withMount(props: Parameters<typeof PoolFormDialog>[0], run: () => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <PoolFormDialog {...props} />, container)
  try {
    run()
  } finally {
    dispose()
    container.remove()
  }
}

function account(id: string, label: string): AccountView {
  return {
    id,
    label,
    provider: "zai",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    weight: 100,
    priority: 0,
    tokenExpiresAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  }
}

const SUB = account("11111111-1111-4111-8111-111111111111", "claude-sub")
const PAID = account("22222222-2222-4222-8222-222222222222", "paid-api-key")
const CORP = account("33333333-3333-4333-8333-333333333333", "corp-key")

function pool(members: readonly AccountView[], overflowAccountId: string | null): PoolView {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "team",
    policy: "sticky",
    overflowAccountId,
    members: members.map((member) => ({
      accountId: member.id,
      label: member.label,
      provider: member.provider,
      status: member.status,
      weight: 100,
      priority: 0,
    })),
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
  }
}

function base(overrides: Partial<Parameters<typeof PoolFormDialog>[0]> = {}) {
  return {
    open: true,
    pool: null,
    accounts: [SUB, PAID, CORP],
    busy: false,
    error: null,
    onSubmit: () => {},
    onClose: () => {},
    ...overrides,
  }
}

const selectWhoseOptionsInclude = (needle: string): HTMLSelectElement => {
  const select = Array.from(document.body.querySelectorAll("select")).find((candidate) =>
    Array.from(candidate.options).some((option) => option.textContent?.startsWith(needle)),
  )
  if (select === undefined) throw new Error(`no select offering "${needle}"`)
  return select
}

const overflowSelect = (): HTMLSelectElement => selectWhoseOptionsInclude("None")
const policySelect = (): HTMLSelectElement => selectWhoseOptionsInclude("round-robin")

const optionLabels = (): readonly string[] =>
  Array.from(overflowSelect().options).map((option) => option.textContent ?? "")

const memberCheckbox = (label: string): HTMLInputElement => {
  const found = Array.from(document.body.querySelectorAll<HTMLLabelElement>("label")).find(
    (element) => element.textContent?.includes(label),
  )
  const input = found?.querySelector("input[type=checkbox]")
  if (!(input instanceof HTMLInputElement)) throw new Error(`no member checkbox for ${label}`)
  return input
}

function submitForm(): void {
  const form = document.body.querySelector("form")
  if (!(form instanceof HTMLFormElement)) throw new Error("form not rendered")
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))
}

describe("PoolFormDialog overflow", () => {
  test("offers only the pool's members — a non-member is not a choice at all", () => {
    withMount(base({ pool: pool([SUB, PAID], PAID.id) }), () => {
      expect(optionLabels()).toEqual(["None", "claude-sub", "paid-api-key"])
      expect(optionLabels()).not.toContain("corp-key")
    })
  })

  test("says to add a member first when the pool holds none", () => {
    withMount(base(), () => {
      expect(optionLabels()).toEqual(["None — add a member first"])
    })
  })

  test("checking an account makes it eligible; unchecking it withdraws the designation", () => {
    let submitted: CreatePoolInput | undefined
    withMount(
      base({ pool: pool([SUB, PAID], PAID.id), onSubmit: (input) => (submitted = input) }),
      () => {
        expect(overflowSelect().value).toBe(PAID.id)

        memberCheckbox("paid-api-key").click()
        expect(optionLabels()).toEqual(["None", "claude-sub"])
        expect(overflowSelect().value).toBe("")

        submitForm()
        expect(submitted?.overflowAccountId).toBeNull()
        expect(submitted?.members).toEqual([{ accountId: SUB.id }])
      },
    )
  })

  test("a pool's stored overflow is the one shown, not the first option", () => {
    // Solid spreads `value` onto the `<select>` before its options exist, so this is only true
    // because `SelectField` re-applies it — without that the operator reads "None" off a pool
    // that has an overflow, and reads "sticky" off a `round-robin` pool.
    withMount(base({ pool: pool([SUB, PAID], PAID.id) }), () => {
      expect(overflowSelect().value).toBe(PAID.id)
      expect(policySelect().value).toBe("sticky")
    })
    withMount(base({ pool: { ...pool([SUB, PAID], PAID.id), policy: "round-robin" } }), () => {
      expect(policySelect().value).toBe("round-robin")
    })
  })

  test("a stored overflow the pool no longer holds is never re-sent", () => {
    // The shape migration 0010 backfills. Until an operator saves, the form must not offer it
    // back as if it were valid.
    let submitted: CreatePoolInput | undefined
    withMount(
      base({ pool: pool([SUB], CORP.id), onSubmit: (input) => (submitted = input) }),
      () => {
        expect(optionLabels()).toEqual(["None", "claude-sub"])
        expect(overflowSelect().value).toBe("")

        submitForm()
        expect(submitted?.overflowAccountId).toBeNull()
      },
    )
  })

  test("a member kept as the overflow round-trips unchanged", () => {
    let submitted: CreatePoolInput | undefined
    withMount(
      base({ pool: pool([SUB, PAID], PAID.id), onSubmit: (input) => (submitted = input) }),
      () => {
        submitForm()
        expect(submitted?.overflowAccountId).toBe(PAID.id)
        expect(submitted?.members).toEqual([{ accountId: SUB.id }, { accountId: PAID.id }])
      },
    )
  })
})
