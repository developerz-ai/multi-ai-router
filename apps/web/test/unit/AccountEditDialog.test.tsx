import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { UpdateAccountInput } from "../../src/lib/api/accounts"
import type { AccountView, ProviderDescriptor } from "../../src/lib/api/types"
import { AccountEditDialog } from "../../src/routes/accounts/AccountEditDialog"
import { fire, typeInto } from "../support/dom"

/**
 * Editing an account is the only way to rotate a credential without deleting the
 * row — and deleting it would take the pool membership, the usage history and
 * every key scoped to it along.
 *
 * Two rules carry security weight and are asserted directly: the credential box
 * is **write-only** (no endpoint returns one, so nothing seeds it and an empty
 * box is "unchanged"), and it is **absent entirely** for a provider with a
 * connect flow — a Claude subscription's tokens live in its own
 * `CLAUDE_CONFIG_DIR` and the router must never hold one (CLAUDE.md
 * non-negotiable 1).
 */
function withMount(props: Parameters<typeof AccountEditDialog>[0], run: () => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(() => <AccountEditDialog {...props} />, container)
  try {
    run()
  } finally {
    dispose()
    container.remove()
  }
}

const HTTP_PROVIDER: ProviderDescriptor = {
  id: "zai",
  transport: "http",
  authKind: "api-key",
  nativeDialect: "anthropic",
  supportedDialects: ["anthropic", "openai-chat"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
}

const SUBSCRIPTION: ProviderDescriptor = {
  ...HTTP_PROVIDER,
  id: "anthropic-subscription",
  transport: "agent-sdk",
  authKind: null,
  supportedDialects: ["anthropic"],
  requiresConfigDir: true,
  connectFlow: "claude-cli",
}

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    label: "zai-primary",
    provider: "zai",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: { "claude-sonnet-4-5": "glm-4.6" },
    supportedModels: ["glm-4.6", "glm-4.7"],
    weight: 300,
    priority: 2,
    tokenExpiresAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

function base(overrides: Partial<Parameters<typeof AccountEditDialog>[0]> = {}) {
  return {
    open: true,
    account: account(),
    provider: HTTP_PROVIDER,
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

const hasFieldLabelled = (text: string): boolean =>
  Array.from(document.body.querySelectorAll("label")).some(
    (element) => element.textContent?.trim().startsWith(text) === true,
  )

const aliasBox = (): HTMLTextAreaElement => {
  const box = document.body.querySelector("textarea")
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("no alias textarea")
  return box
}

function submitForm(): void {
  const form = document.body.querySelector("form")
  if (!(form instanceof HTMLFormElement)) throw new Error("form not rendered")
  fire(form, "submit")
}

describe("AccountEditDialog seeding", () => {
  test("opens on the account's own label, models, aliases and routing numbers", () => {
    withMount(base({ account: account({ baseUrl: "https://proxy.example/v1" }) }), () => {
      expect(fieldByLabel("Label").value).toBe("zai-primary")
      expect(fieldByLabel("Base URL").value).toBe("https://proxy.example/v1")
      expect(fieldByLabel("Models it serves").value).toBe("glm-4.6, glm-4.7")
      expect(aliasBox().value).toBe("claude-sonnet-4-5 = glm-4.6")
      expect(fieldByLabel("Weight").value).toBe("300")
      expect(fieldByLabel("Priority").value).toBe("2")
    })
  })

  test("the credential box opens empty — nothing in this console can read one", () => {
    withMount(base(), () => {
      const box = fieldByLabel("Rotate credential")
      expect(box.value).toBe("")
      expect(box.type).toBe("password")
    })
  })

  test("never offers a paste box for an account that is logged in, not pasted", () => {
    withMount(base({ provider: SUBSCRIPTION, account: account({ provider: "zai" }) }), () => {
      expect(hasFieldLabelled("Rotate credential")).toBe(false)
      expect(document.body.querySelector("input[type=password]")).toBeNull()
      expect(document.body.textContent).toContain("logged in, not pasted")
    })
  })

  test("shows the account's stored dialect, not the first option", () => {
    // `SelectField` re-applies its value after the options exist; without that an account
    // addressed on `openai-chat` reads as "Provider default" and saving flattens it.
    withMount(base({ account: account({ dialect: "openai-chat" }) }), () => {
      const select = document.body.querySelector("select")
      expect(select instanceof HTMLSelectElement && select.value).toBe("openai-chat")
    })
  })

  test("offers no dialect control for a provider that serves exactly one", () => {
    withMount(base({ provider: SUBSCRIPTION }), () => {
      expect(document.body.querySelector("select")).toBeNull()
    })
  })

  test("says the provider cannot be changed rather than offering a control that lies", () => {
    withMount(base(), () => {
      expect(hasFieldLabelled("Provider")).toBe(false)
      expect(document.body.textContent).toContain("not editable")
    })
  })
})

describe("AccountEditDialog submission", () => {
  test("an untouched credential box is absent from the patch, never an empty rotation", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      submitForm()
      expect(patch).toBeDefined()
      expect("credential" in (patch ?? {})).toBe(false)
    })
  })

  test("a typed credential rotates it", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Rotate credential"), "sk-rotated")
      submitForm()
      expect(patch?.credential).toBe("sk-rotated")
    })
  })

  test("an unedited account round-trips every field it already holds", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      submitForm()
      expect(patch?.label).toBe("zai-primary")
      expect(patch?.supportedModels).toEqual(["glm-4.6", "glm-4.7"])
      expect(patch?.modelAliases).toEqual({ "claude-sonnet-4-5": "glm-4.6" })
      expect(patch?.weight).toBe(300)
      expect(patch?.priority).toBe(2)
    })
  })

  test("emptying a cleared-by-null field clears it, which is what null is for", () => {
    let patch: UpdateAccountInput | undefined
    withMount(
      base({
        account: account({ baseUrl: "https://proxy.example/v1", dialect: "openai-chat" }),
        onSubmit: (next) => (patch = next),
      }),
      () => {
        typeInto(fieldByLabel("Base URL"), "")
        typeInto(fieldByLabel("Models it serves"), "")
        typeInto(aliasBox(), "")
        submitForm()
        expect(patch?.baseUrl).toBeNull()
        expect(patch?.supportedModels).toBeNull()
        expect(patch?.modelAliases).toBeNull()
        expect(patch?.dialect).toBe("openai-chat")
      },
    )
  })

  test("edited routing numbers are sent as numbers, not strings", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Weight"), "50")
      typeInto(fieldByLabel("Priority"), "0")
      submitForm()
      expect(patch?.weight).toBe(50)
      expect(patch?.priority).toBe(0)
    })
  })

  test("a box mid-retype re-sends what the account holds, never a silent zero", () => {
    // `weight: 0` drops the account out of the weighted policy entirely, so an emptied
    // box must not become one.
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Weight"), "")
      submitForm()
      expect(patch?.weight).toBe(300)
    })
  })

  test("refuses an unreadable alias map in the operator's line numbers, and sends nothing", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(aliasBox(), "claude-sonnet-4-5 = glm-4.6\nglm-4.7")
      expect(document.body.textContent).toContain("line 2 is not a pair")

      submitForm()
      expect(patch).toBeUndefined()
    })
  })

  test("a rewritten alias map goes up requested-side keyed, as routing reads it", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(aliasBox(), "gpt-5 = glm-4.7\nclaude-opus-4-1 = glm-4.6")
      submitForm()
      expect(patch?.modelAliases).toEqual({ "gpt-5": "glm-4.7", "claude-opus-4-1": "glm-4.6" })
    })
  })
})
