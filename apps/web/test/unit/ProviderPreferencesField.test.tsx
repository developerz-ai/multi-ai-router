import { describe, expect, test } from "bun:test"
import { render } from "solid-js/web"
import type { UpdateAccountInput } from "../../src/lib/api/accounts"
import type { AccountView, ProviderDescriptor } from "../../src/lib/api/types"
import { AccountEditDialog } from "../../src/routes/accounts/AccountEditDialog"
import { fire, typeInto } from "../support/dom"

/**
 * The OpenRouter `provider` preferences box on the account edit form: shown only where the
 * provider descriptor says its surface reads the field, seeded from the stored object, sent as an
 * object (or `null` to clear), and never sent at all for any other provider — an edit of an account
 * whose preferences this form never displayed must not clear them.
 */

const OPENROUTER: ProviderDescriptor = {
  id: "openrouter",
  transport: "http",
  authKind: "api-key",
  nativeDialect: "openai-chat",
  supportedDialects: ["openai-chat"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
  defaultBilling: "metered",
  billingFixed: false,
  providerPreferences: true,
}

const CODING = { sort: "price", quantizations: ["fp8", "bf16"], allow_fallbacks: true }

function account(overrides: Partial<AccountView> = {}): AccountView {
  return {
    id: "8b609813-f618-409c-85e9-60373a618fcf",
    label: "openrouter-dz-coding-30d",
    provider: "openrouter",
    status: "active",
    hasCredential: true,
    configDir: null,
    baseUrl: null,
    dialect: null,
    modelAliases: null,
    supportedModels: null,
    windowTokenLimits: null,
    providerPreferences: null,
    weight: 100,
    priority: 0,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-11-14T12:00:00.000Z",
    updatedAt: "2026-11-14T12:00:00.000Z",
    ...overrides,
  }
}

function mounted(
  props: { account?: AccountView; provider?: ProviderDescriptor },
  run: (submit: () => UpdateAccountInput | undefined) => void,
): void {
  let patch: UpdateAccountInput | undefined
  const container = document.createElement("div")
  document.body.appendChild(container)
  const dispose = render(
    () => (
      <AccountEditDialog
        account={props.account ?? account()}
        busy={false}
        error={null}
        onClose={() => {}}
        onSubmit={(next) => (patch = next)}
        open
        provider={props.provider ?? OPENROUTER}
      />
    ),
    container,
  )
  const submit = () => {
    const form = document.body.querySelector("form")
    if (!(form instanceof HTMLFormElement)) throw new Error("form not rendered")
    fire(form, "submit")
    return patch
  }
  try {
    run(submit)
  } finally {
    dispose()
    container.remove()
  }
}

const preferencesBox = (): HTMLTextAreaElement | null => {
  const label = Array.from(document.body.querySelectorAll("label")).find((element) =>
    element.textContent?.trim().startsWith("Provider preferences"),
  )
  const box = label === undefined ? null : document.getElementById(label.htmlFor)
  return box instanceof HTMLTextAreaElement ? box : null
}

describe("provider preferences on the account edit form, refusals first", () => {
  test("an unreadable object is refused in the browser and nothing is sent", () => {
    mounted({}, (submit) => {
      const box = preferencesBox()
      if (box === null) throw new Error("no preferences box")
      typeInto(box, '{"sort": "price",')
      expect(document.body.textContent).toContain("not a JSON object")
      expect(submit()).toBeUndefined()
    })
  })

  test("a provider that takes none shows no box and sends no field", () => {
    mounted(
      { provider: { ...OPENROUTER, id: "deepseek", providerPreferences: false } },
      (submit) => {
        expect(preferencesBox()).toBeNull()
        expect("providerPreferences" in (submit() ?? {})).toBe(false)
      },
    )
  })

  test("opens on the stored object and round-trips it untouched", () => {
    mounted({ account: account({ providerPreferences: CODING }) }, (submit) => {
      expect(JSON.parse(preferencesBox()?.value ?? "")).toEqual(CODING)
      expect(submit()?.providerPreferences).toEqual(CODING)
    })
  })

  test("typed preferences go up as an object; an emptied box clears with null", () => {
    mounted({}, (submit) => {
      const box = preferencesBox()
      if (box === null) throw new Error("no preferences box")
      typeInto(box, JSON.stringify(CODING))
      expect(submit()?.providerPreferences).toEqual(CODING)
      typeInto(box, "  ")
      expect(submit()?.providerPreferences).toBeNull()
    })
  })
})
