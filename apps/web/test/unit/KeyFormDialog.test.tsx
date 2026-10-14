import { describe, expect, test } from "bun:test"
import { KEY_LABEL_SLUG_HTML_PATTERN } from "@multi-ai-router/core"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { AccountView, ApiKeyView, PoolView } from "../../src/lib/api/types"
import { KeyFormDialog } from "../../src/routes/keys/KeyFormDialog"
import { type KeyFormValues, toCreateKeyInput } from "../../src/routes/keys/key-form-values"
import { fire, selectOption, typeInto } from "../support/dom"

/**
 * Editing a key is the difference between "fix this scope" and "delete it and
 * tell every client to swap credentials". The value never changes across an
 * edit — keys are stored encrypted, not hashed — so these assert the form can
 * express every field `PATCH /keys/:id` accepts, including the two removals that
 * only exist on that verb: `rateLimit: null` and `expiresAt: null`.
 *
 * Mounted through the real `Modal`/`Portal` stack; `dispose` always runs,
 * because portal content lives under a `document.body` this process shares.
 */
function withMount(props: Parameters<typeof KeyFormDialog>[0], run: () => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <KeyFormDialog {...props} />, container)
  try {
    run()
  } finally {
    dispose()
    container.remove()
  }
}

const POOL: PoolView = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "team",
  policy: "sticky",
  overflowAccountId: null,
  members: [],
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
}

const OTHER_POOL: PoolView = { ...POOL, id: "22222222-2222-4222-8222-222222222222", name: "eu" }

const ALL_SCOPE = { kind: "all", poolIds: [], accountIds: [] } as const

const ACCOUNT: AccountView = {
  id: "33333333-3333-4333-8333-333333333333",
  label: "claude-sub",
  provider: "zai",
  status: "active",
  hasCredential: true,
  configDir: null,
  baseUrl: null,
  dialect: null,
  modelAliases: null,
  supportedModels: null,
  weight: 100,
  priority: 0,
  tokenExpiresAt: null,
  createdAt: "2026-07-24T12:00:00.000Z",
  updatedAt: "2026-07-24T12:00:00.000Z",
}

function key(overrides: Partial<ApiKeyView> = {}): ApiKeyView {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    name: "ci-agent-3",
    prefix: "mar_live_abcd",
    owner: null,
    ownerKind: null,
    tool: null,
    purpose: null,
    scope: { kind: "pools", poolIds: [POOL.id], accountIds: [] },
    rateLimit: { requests: 60, windowSeconds: 60 },
    expiresAt: null,
    revoked: false,
    revokedAt: null,
    lastUsedAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

function base(overrides: Partial<Parameters<typeof KeyFormDialog>[0]> = {}) {
  return {
    open: true,
    apiKey: null,
    successorOf: null,
    pools: [POOL, OTHER_POOL],
    accounts: [ACCOUNT],
    busy: false,
    error: null,
    onSubmit: () => {},
    onClose: () => {},
    ...overrides,
  }
}

const fieldByLabel = (text: string): HTMLInputElement => {
  const label = Array.from(document.body.querySelectorAll("label")).find(
    (element) => element.textContent?.trim().startsWith(text) === true,
  )
  const input = label === undefined ? null : document.getElementById(label.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled "${text}"`)
  return input
}

const selectByLabel = (text: string): HTMLSelectElement => {
  const label = Array.from(document.body.querySelectorAll("label")).find(
    (element) => element.textContent?.trim().startsWith(text) === true,
  )
  const select = label === undefined ? null : document.getElementById(label.htmlFor)
  if (!(select instanceof HTMLSelectElement)) throw new Error(`no select labelled "${text}"`)
  return select
}

const scopeSelect = (): HTMLSelectElement => selectByLabel("Scope")

const targetCheckbox = (name: string): HTMLInputElement => {
  const found = Array.from(document.body.querySelectorAll<HTMLLabelElement>("label")).find(
    (element) => element.textContent?.includes(name),
  )
  const input = found?.querySelector("input[type=checkbox]")
  if (!(input instanceof HTMLInputElement)) throw new Error(`no target checkbox for ${name}`)
  return input
}

function submitForm(): void {
  const form = document.body.querySelector("form")
  if (!(form instanceof HTMLFormElement)) throw new Error("form not rendered")
  fire(form, "submit")
}

describe("KeyFormDialog editing", () => {
  test("opens on the key's own name, scope, targets, ceiling and expiry", () => {
    withMount(
      base({ apiKey: key({ expiresAt: "2026-12-01T09:30:00.000Z" }), pools: [POOL, OTHER_POOL] }),
      () => {
        expect(fieldByLabel("Name").value).toBe("ci-agent-3")
        expect(scopeSelect().value).toBe("pools")
        expect(targetCheckbox("team").checked).toBe(true)
        expect(targetCheckbox("eu").checked).toBe(false)
        expect(fieldByLabel("Requests").value).toBe("60")
        expect(fieldByLabel("Per (seconds)").value).toBe("60")
        // Local wall time, so only the round-trip is assertable in any timezone.
        expect(fieldByLabel("Expires at").value).not.toBe("")
      },
    )
  })

  test("saves the button an operator can act on, and titles the dialog with the key", () => {
    withMount(base({ apiKey: key() }), () => {
      expect(document.body.textContent).toContain("Save key")
      expect(document.body.textContent).toContain("Edit ci-agent-3")
      expect(document.body.textContent).not.toContain("Mint key")
    })
  })

  test("re-scoping a key sends the new scope and nothing else it did not touch", () => {
    let submitted: KeyFormValues | undefined
    withMount(base({ apiKey: key(), onSubmit: (values) => (submitted = values) }), () => {
      targetCheckbox("eu").click()
      submitForm()
      expect(submitted?.scope).toEqual({ kind: "pools", poolIds: [POOL.id, OTHER_POOL.id] })
      expect(submitted?.name).toBe("ci-agent-3")
      expect(submitted?.rateLimit).toEqual({ requests: 60, windowSeconds: 60 })
    })
  })

  test("emptying both halves of the ceiling removes it — null, not an omission", () => {
    // The whole reason the form states every field: an omitted `rateLimit` on a PATCH
    // leaves the stored one alone, so there would be no way to take a ceiling off at all.
    let submitted: KeyFormValues | undefined
    withMount(base({ apiKey: key(), onSubmit: (values) => (submitted = values) }), () => {
      typeInto(fieldByLabel("Requests"), "")
      typeInto(fieldByLabel("Per (seconds)"), "")
      submitForm()
      expect(submitted?.rateLimit).toBeNull()
    })
  })

  test("a ceiling can be set on a key minted without one", () => {
    let submitted: KeyFormValues | undefined
    withMount(
      base({ apiKey: key({ rateLimit: null }), onSubmit: (values) => (submitted = values) }),
      () => {
        expect(fieldByLabel("Requests").value).toBe("")
        typeInto(fieldByLabel("Requests"), "120")
        typeInto(fieldByLabel("Per (seconds)"), "3600")
        submitForm()
        expect(submitted?.rateLimit).toEqual({ requests: 120, windowSeconds: 3600 })
      },
    )
  })

  test("clearing the expiry makes the key non-expiring, and it round-trips otherwise", () => {
    let submitted: KeyFormValues | undefined
    withMount(
      base({
        apiKey: key({ expiresAt: "2026-12-01T09:30:00.000Z" }),
        onSubmit: (values) => (submitted = values),
      }),
      () => {
        submitForm()
        expect(submitted?.expiresAt).toBe("2026-12-01T09:30:00.000Z")

        typeInto(fieldByLabel("Expires at"), "")
        submitForm()
        expect(submitted?.expiresAt).toBeNull()
      },
    )
  })

  test("switching a scoped key to all drops its targets", () => {
    let submitted: KeyFormValues | undefined
    withMount(base({ apiKey: key(), onSubmit: (values) => (submitted = values) }), () => {
      selectOption(scopeSelect(), "all")
      submitForm()
      expect(submitted?.scope).toEqual({ kind: "all" })
    })
  })

  test("a scope naming nothing says so rather than swallowing the submit", () => {
    let submitted: KeyFormValues | undefined
    withMount(base({ apiKey: key(), onSubmit: (values) => (submitted = values) }), () => {
      targetCheckbox("team").click()
      expect(document.body.textContent).toContain("Choose at least one pool")

      submitForm()
      expect(submitted).toBeUndefined()
    })
  })

  test("the mint form never inherits the key that was edited before it", () => {
    // Driven through real prop changes rather than a fresh mount, because that is the only
    // shape the bug has: one long-lived dialog reopened on a different key, or on none.
    const [apiKey, setApiKey] = createSignal<ApiKeyView | null>(key())
    const [open, setOpen] = createSignal(true)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => <KeyFormDialog {...base()} apiKey={apiKey()} open={open()} />,
      container,
    )

    try {
      expect(fieldByLabel("Name").value).toBe("ci-agent-3")

      setOpen(false)
      setApiKey(null)
      setOpen(true)

      expect(fieldByLabel("Name").value).toBe("")
      expect(scopeSelect().value).toBe("all")
      expect(fieldByLabel("Requests").value).toBe("")
      expect(document.body.textContent).toContain("Mint key")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("reopening on a different key shows that key, not the last one", () => {
    const [apiKey, setApiKey] = createSignal<ApiKeyView | null>(key())
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(() => <KeyFormDialog {...base()} apiKey={apiKey()} />, container)

    try {
      expect(fieldByLabel("Name").value).toBe("ci-agent-3")
      setApiKey(key({ id: "x", name: "laptop", rateLimit: null, scope: ALL_SCOPE }))
      expect(fieldByLabel("Name").value).toBe("laptop")
      expect(scopeSelect().value).toBe("all")
      expect(fieldByLabel("Requests").value).toBe("")
    } finally {
      dispose()
      container.remove()
    }
  })

  test("has no field that could change the key's value", () => {
    withMount(base({ apiKey: key() }), () => {
      expect(document.body.querySelector("input[type=password]")).toBeNull()
      expect(document.body.textContent).not.toContain("shown once")
      expect(document.body.textContent).toContain("never changes its value")
    })
  })
})

describe("KeyFormDialog attribution", () => {
  test("opens on the key's own owner, owner kind, tool and purpose", () => {
    withMount(
      base({
        apiKey: key({
          owner: "ci-team",
          ownerKind: "service",
          tool: "claude-code",
          purpose: "nightly builds",
        }),
      }),
      () => {
        expect(fieldByLabel("Owner").value).toBe("ci-team")
        expect(selectByLabel("Owner kind").value).toBe("service")
        expect(fieldByLabel("Tool").value).toBe("claude-code")
        expect(fieldByLabel("Purpose").value).toBe("nightly builds")
      },
    )
  })

  test("the Owner and Tool inputs carry the core slug rule as their HTML pattern", () => {
    withMount(base({ apiKey: key() }), () => {
      expect(fieldByLabel("Owner").getAttribute("pattern")).toBe(KEY_LABEL_SLUG_HTML_PATTERN)
      expect(fieldByLabel("Tool").getAttribute("pattern")).toBe(KEY_LABEL_SLUG_HTML_PATTERN)
    })
  })

  test("an unattributed key opens with every label empty and none selected", () => {
    withMount(base({ apiKey: key() }), () => {
      expect(fieldByLabel("Owner").value).toBe("")
      expect(selectByLabel("Owner kind").value).toBe("none")
      expect(fieldByLabel("Tool").value).toBe("")
      expect(fieldByLabel("Purpose").value).toBe("")
    })
  })

  test("submits trimmed labels, and null for the emptied ones — the PATCH spelling that clears", () => {
    let submitted: KeyFormValues | undefined
    withMount(
      base({
        apiKey: key({
          owner: "ci-team",
          ownerKind: "person",
          tool: "claude-code",
          purpose: "nightly builds",
        }),
        onSubmit: (values) => (submitted = values),
      }),
      () => {
        // Owner carries an HTML `pattern`, so a browser blocks padded input before
        // submit; the free-text purpose is what actually reaches the trim.
        typeInto(fieldByLabel("Owner"), "marta")
        typeInto(fieldByLabel("Purpose"), "   ")
        submitForm()
        expect(submitted?.owner).toBe("marta")
        expect(submitted?.purpose).toBeNull()
        // Untouched labels pass through as the key stores them.
        expect(submitted?.ownerKind).toBe("person")
        expect(submitted?.tool).toBe("claude-code")

        typeInto(fieldByLabel("Tool"), "")
        selectOption(selectByLabel("Owner kind"), "none")
        submitForm()
        expect(submitted?.tool).toBeNull()
        expect(submitted?.ownerKind).toBeNull()
      },
    )
  })
})

describe("KeyFormDialog minting a successor", () => {
  const SOURCE = key({
    owner: "ci-team",
    ownerKind: "service",
    tool: "claude-code",
    purpose: "nightly builds",
    rateLimit: { requests: 120, windowSeconds: 300 },
    expiresAt: "2026-12-01T09:30:00.000Z",
  })

  test("prefills attribution, scope and ceiling from the source key, name empty, no expiry", () => {
    let submitted: KeyFormValues | undefined
    withMount(base({ successorOf: SOURCE, onSubmit: (values) => (submitted = values) }), () => {
      expect(document.body.textContent).toContain("Mint key")
      expect(fieldByLabel("Name").value).toBe("")
      expect(fieldByLabel("Owner").value).toBe("ci-team")
      expect(selectByLabel("Owner kind").value).toBe("service")
      expect(fieldByLabel("Tool").value).toBe("claude-code")
      expect(fieldByLabel("Purpose").value).toBe("nightly builds")
      expect(scopeSelect().value).toBe("pools")
      expect(targetCheckbox("team").checked).toBe(true)
      expect(fieldByLabel("Requests").value).toBe("120")
      expect(fieldByLabel("Per (seconds)").value).toBe("300")
      // A lifetime is per key — the successor starts unexpired.
      expect(fieldByLabel("Expires at").value).toBe("")

      submitForm()
      if (submitted === undefined) throw new Error("form did not submit")
      expect(toCreateKeyInput(submitted)).toEqual({
        name: "",
        scope: { kind: "pools", poolIds: [POOL.id] },
        rateLimit: { requests: 120, windowSeconds: 300 },
        owner: "ci-team",
        ownerKind: "service",
        tool: "claude-code",
        purpose: "nightly builds",
      })
    })
  })

  test("never shows the source key's value — a successor is a fresh one", () => {
    withMount(base({ successorOf: SOURCE }), () => {
      expect(document.body.textContent).not.toContain(SOURCE.prefix)
      expect(document.body.querySelector("input[type=password]")).toBeNull()
    })
  })

  test("a plain mint still starts empty — the successor is not sticky either", () => {
    const [successorOf, setSuccessorOf] = createSignal<ApiKeyView | null>(SOURCE)
    const container = document.createElement("div")
    document.body.appendChild(container)
    const dispose = render(
      () => <KeyFormDialog {...base({ successorOf: successorOf() })} />,
      container,
    )

    try {
      expect(fieldByLabel("Owner").value).toBe("ci-team")
      setSuccessorOf(null)
      expect(fieldByLabel("Owner").value).toBe("")
      expect(fieldByLabel("Name").value).toBe("")
      expect(scopeSelect().value).toBe("all")
    } finally {
      dispose()
      container.remove()
    }
  })
})

describe("toCreateKeyInput", () => {
  test("drops the nulls, because the mint body is strict and not nullable", () => {
    expect(
      toCreateKeyInput({
        name: "ci",
        owner: null,
        ownerKind: null,
        tool: null,
        purpose: null,
        scope: { kind: "all" },
        rateLimit: null,
        expiresAt: null,
      }),
    ).toEqual({ name: "ci", scope: { kind: "all" } })
  })

  test("carries a stated ceiling and expiry through unchanged", () => {
    expect(
      toCreateKeyInput({
        name: "ci",
        owner: null,
        ownerKind: null,
        tool: null,
        purpose: null,
        scope: { kind: "pools", poolIds: [POOL.id] },
        rateLimit: { requests: 60, windowSeconds: 60 },
        expiresAt: "2026-12-01T09:30:00.000Z",
      }),
    ).toEqual({
      name: "ci",
      scope: { kind: "pools", poolIds: [POOL.id] },
      rateLimit: { requests: 60, windowSeconds: 60 },
      expiresAt: "2026-12-01T09:30:00.000Z",
    })
  })

  test("carries stated attribution through, and drops the absent half", () => {
    expect(
      toCreateKeyInput({
        name: "ci",
        owner: "marta",
        ownerKind: "person",
        tool: null,
        purpose: "laptop coding",
        scope: { kind: "all" },
        rateLimit: null,
        expiresAt: null,
      }),
    ).toEqual({
      name: "ci",
      owner: "marta",
      ownerKind: "person",
      purpose: "laptop coding",
      scope: { kind: "all" },
    })
  })
})
