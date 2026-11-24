import { describe, expect, test } from "bun:test"
import type { UpdateAccountInput } from "../../src/lib/api/accounts"
import {
  account,
  aliasBox,
  base,
  fieldByLabel,
  hasFieldLabelled,
  SUBSCRIPTION,
  submitForm,
  withMount,
} from "../support/account-edit"
import { typeInto } from "../support/dom"

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
      // The one exception: an unchanged model list is not re-sent. A replace from a dialog opened
      // before another edit would drop ids it never saw, so the list goes only when it moved.
      expect(patch).not.toHaveProperty("supportedModels")
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
        expect(patch?.supportedModelsRemoving).toEqual(["glm-4.6", "glm-4.7"])
        expect(patch?.modelAliases).toBeNull()
        expect(patch?.dialect).toBe("openai-chat")
      },
    )
  })

  test("an added model sends the list and names nothing removed", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Models it serves"), "glm-4.6, glm-4.7, glm-5")
      submitForm()
      expect(patch?.supportedModels).toEqual(["glm-4.6", "glm-4.7", "glm-5"])
      expect(patch).not.toHaveProperty("supportedModelsRemoving")
    })
  })

  test("a removed model is named in supportedModelsRemoving", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Models it serves"), "glm-4.7")
      submitForm()
      expect(patch?.supportedModels).toEqual(["glm-4.7"])
      expect(patch?.supportedModelsRemoving).toEqual(["glm-4.6"])
    })
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
