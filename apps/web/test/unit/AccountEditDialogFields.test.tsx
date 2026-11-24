import { describe, expect, test } from "bun:test"
import type { UpdateAccountInput } from "../../src/lib/api/accounts"
import { ApiError } from "../../src/lib/api/errors"
import type { AccountView } from "../../src/lib/api/types"
import {
  account,
  base,
  fieldByLabel,
  hasFieldLabelled,
  SUBSCRIPTION,
  submitForm,
  withMount,
} from "../support/account-edit"
import { selectOption, typeInto } from "../support/dom"

/** The fields only some providers have, and the endpoint move that needs a key. */

describe("AccountEditDialog window token ceilings", () => {
  const subAccount = (overrides: Partial<AccountView> = {}) =>
    account({ provider: "anthropic-oauth", billing: "subscription", ...overrides })

  test("offers no ceiling boxes for an http provider, and never sends the field", () => {
    // An http account reports no named windows, so a ceiling would draw nothing — and sending
    // `null` from a form that never displayed the boxes would silently clear limits set elsewhere.
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      expect(hasFieldLabelled("5h tokens")).toBe(false)
      submitForm()
      expect(patch).toBeDefined()
      expect("windowTokenLimits" in (patch ?? {})).toBe(false)
    })
  })

  test("seeds each box from the stored ceiling, and offers no box for overage", () => {
    withMount(
      base({
        provider: SUBSCRIPTION,
        account: subAccount({ windowTokenLimits: { five_hour: 3_000_000 } }),
      }),
      () => {
        expect(fieldByLabel("5h tokens").value).toBe("3000000")
        expect(fieldByLabel("7d tokens").value).toBe("")
        expect(hasFieldLabelled("7d Opus tokens")).toBe(true)
        expect(hasFieldLabelled("7d Sonnet tokens")).toBe(true)
        // No span, so no bar can ever be drawn for it — a box would be a silent no-op.
        expect(hasFieldLabelled("Overage")).toBe(false)
      },
    )
  })

  test("typed ceilings go up as numbers, keeping the ones already stored", () => {
    let patch: UpdateAccountInput | undefined
    withMount(
      base({
        provider: SUBSCRIPTION,
        account: subAccount({ windowTokenLimits: { five_hour: 3_000_000 } }),
        onSubmit: (next) => (patch = next),
      }),
      () => {
        typeInto(fieldByLabel("7d tokens"), "5000000")
        submitForm()
        expect(patch?.windowTokenLimits).toEqual({ five_hour: 3_000_000, seven_day: 5_000_000 })
      },
    )
  })

  test("all boxes empty sends null — the clear-everything spelling, not a zero", () => {
    let patch: UpdateAccountInput | undefined
    withMount(
      base({
        provider: SUBSCRIPTION,
        account: subAccount({ windowTokenLimits: { five_hour: 3_000_000 } }),
        onSubmit: (next) => (patch = next),
      }),
      () => {
        typeInto(fieldByLabel("5h tokens"), "")
        submitForm()
        expect(patch?.windowTokenLimits).toBeNull()
      },
    )
  })
})

describe("AccountEditDialog billing", () => {
  const billingSelect = (): HTMLSelectElement => {
    const select = Array.from(document.body.querySelectorAll("select")).find((element) =>
      element.textContent?.includes("billed per token"),
    )
    if (select === undefined) throw new Error("no billing select")
    return select
  }

  test("seeds from the account's stored mode, not from the first option", () => {
    // The same failure the dialect control had: an account already on a coding plan that reads as
    // "metered" is one save away from having its cost basis silently flattened.
    withMount(base({ account: account({ billing: "subscription" }) }), () => {
      expect(billingSelect().value).toBe("subscription")
    })
  })

  test("states the consequence, because the two words alone name no column", () => {
    withMount(base({ account: account({ billing: "subscription" }) }), () => {
      expect(document.body.textContent).toContain("notional")
      expect(document.body.textContent).toContain("never summed")
    })
  })

  test("sends the mode on every save, so an untouched control is not a silent no-op", () => {
    // `PATCH` reads an absent field as "leave it". A control the operator can see but that sends
    // nothing is a control that does not work — the bug this dialog already had for weights.
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      submitForm()
      expect(patch?.billing).toBe("metered")
    })
  })

  test("carries a change through to the patch", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      selectOption(billingSelect(), "subscription")
      submitForm()
      expect(patch?.billing).toBe("subscription")
    })
  })

  test("offers no control for a provider sold only as a subscription, and says why", () => {
    let patch: UpdateAccountInput | undefined
    withMount(
      base({
        provider: SUBSCRIPTION,
        account: account({ provider: "anthropic-oauth", billing: "subscription" }),
        onSubmit: (next) => (patch = next),
      }),
      () => {
        expect(document.body.textContent).toContain("no per-token price to meter")
        // Never sent: the API refuses the field for this provider whichever value it carries.
        submitForm()
        expect(patch).toBeDefined()
        expect(patch?.billing).toBeUndefined()
      },
    )
  })
})

describe("AccountEditDialog moving an endpoint", () => {
  const stored = () => account({ baseUrl: "https://a.example/v1" })

  test("another host asks for the key, and sends nothing without it", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ account: stored(), onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Base URL"), "https://b.example/v1")
      expect(fieldByLabel("Rotate credential").required).toBe(true)
      expect(document.body.textContent).toContain("another host")
      submitForm()
      expect(patch).toBeUndefined()
      typeInto(fieldByLabel("Rotate credential"), "sk-new")
      submitForm()
      expect(patch?.credential).toBe("sk-new")
      expect(patch?.baseUrl).toBe("https://b.example/v1")
    })
  })

  test("a path on the same host, or an account that stores no key, asks for nothing", () => {
    withMount(base({ account: stored() }), () => {
      typeInto(fieldByLabel("Base URL"), "https://a.example/v2")
      expect(fieldByLabel("Rotate credential").required).toBe(false)
    })
    withMount(base({ account: { ...stored(), hasCredential: false } }), () => {
      typeInto(fieldByLabel("Base URL"), "https://b.example/v1")
      expect(fieldByLabel("Rotate credential").required).toBe(false)
    })
  })

  test("a dialect can move it too, and a save the router refused for it asks for the key", () => {
    withMount(base(), () => {
      const dialect = document.body.querySelector("select")
      if (dialect === null) throw new Error("no dialect select")
      selectOption(dialect, "openai-chat")
      expect(document.body.textContent).toContain("type the key again")
    })
    const refused = new ApiError(400, {
      message: "another host",
      type: null,
      code: "credential_required_for_new_endpoint",
    })
    withMount(base({ error: refused }), () => {
      expect(fieldByLabel("Rotate credential").required).toBe(false)
      const dialect = document.body.querySelector("select")
      if (dialect === null) throw new Error("no dialect select")
      selectOption(dialect, "openai-chat")
      expect(fieldByLabel("Rotate credential").required).toBe(true)
    })
  })

  test("leaving the provider's own endpoint explains, and lets the router decide", () => {
    let patch: UpdateAccountInput | undefined
    withMount(base({ onSubmit: (next) => (patch = next) }), () => {
      typeInto(fieldByLabel("Base URL"), "https://b.example/v1")
      expect(fieldByLabel("Rotate credential").required).toBe(false)
      expect(document.body.textContent).toContain("type the key again")
      submitForm()
      expect(patch?.baseUrl).toBe("https://b.example/v1")
    })
  })
})
