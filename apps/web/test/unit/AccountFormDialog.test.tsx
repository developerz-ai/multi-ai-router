import { describe, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import type { CreateAccountInput } from "../../src/lib/api/accounts"
import type { ProviderDescriptor } from "../../src/lib/api/types"
import { AccountFormDialog } from "../../src/routes/accounts/AccountFormDialog"
import { fire, selectOption, typeInto } from "../support/dom"

/**
 * The add form stays mounted for the page's life, so its fields outlive every close and every
 * provider change. What an operator typed for one account must not reach another: a hidden base
 * URL sent with a key is that key delivered to the wrong host.
 */

const API_KEY: ProviderDescriptor = {
  id: "zai",
  transport: "http",
  authKind: "api-key",
  nativeDialect: "anthropic",
  supportedDialects: ["anthropic"],
  requiresBaseUrl: false,
  requiresConfigDir: false,
  connectFlow: null,
  creatable: true,
  reason: null,
  defaultBilling: "metered",
  billingFixed: false,
}

const OPENCODE_GO: ProviderDescriptor = {
  ...API_KEY,
  id: "opencode-go",
  nativeDialect: "openai-chat",
  supportedDialects: ["anthropic", "openai-chat", "openai-responses"],
  defaultBilling: "subscription",
  billingFixed: true,
}

const COMPATIBLE: ProviderDescriptor = {
  ...API_KEY,
  id: "openai-compatible",
  nativeDialect: "openai-chat",
  supportedDialects: ["openai-chat"],
  requiresBaseUrl: true,
}

const OAUTH: ProviderDescriptor = { ...API_KEY, id: "openai-oauth", connectFlow: "oauth" }

const PROVIDERS = [API_KEY, OPENCODE_GO, COMPATIBLE, OAUTH]

interface Mounted {
  readonly submitted: CreateAccountInput[]
  readonly setOpen: (open: boolean) => void
}

function withMount(run: (mounted: Mounted) => void): void {
  const container = document.createElement("div")
  document.body.appendChild(container)
  const submitted: CreateAccountInput[] = []
  let setOpen: (open: boolean) => void = () => {}
  const dispose = render(() => {
    const [open, set] = createSignal(true)
    setOpen = set
    return (
      <AccountFormDialog
        busy={false}
        error={null}
        onClose={() => {}}
        onSubmit={(input) => submitted.push(input)}
        open={open()}
        providers={PROVIDERS}
      />
    )
  }, container)
  try {
    run({ submitted, setOpen })
  } finally {
    dispose()
    container.remove()
  }
}

function control<T extends HTMLElement>(label: string): T {
  const element = [...document.body.querySelectorAll("label")].find((candidate) =>
    candidate.textContent?.startsWith(label),
  )
  const found = document.getElementById(element?.getAttribute("for") ?? "")
  if (found === null) throw new Error(`no control labelled ${label}`)
  return found as T
}

const pickProvider = (id: string) => selectOption(control<HTMLSelectElement>("Provider"), id)

function submit(): void {
  const form = document.body.querySelector("form")
  if (form === null) throw new Error("no form")
  fire(form, "submit")
}

describe("AccountFormDialog across a provider change", () => {
  test("a dialect picked for the last provider is not sent with the next one", () => {
    withMount(({ submitted }) => {
      pickProvider("opencode-go")
      selectOption(control<HTMLSelectElement>("Dialect"), "openai-responses")
      pickProvider("zai")
      submit()
      expect(submitted[0]?.dialect).toBeUndefined()
    })
  })

  test("a base URL typed for a compatible endpoint is not sent with a pinned provider", () => {
    withMount(({ submitted }) => {
      pickProvider("openai-compatible")
      typeInto(control<HTMLInputElement>("Base URL"), "https://proxy.example.test/v1")
      pickProvider("zai")
      submit()
      expect(submitted[0]?.baseUrl).toBeUndefined()
    })
  })

  test("a key pasted before switching to a login provider is not sent as an import", () => {
    withMount(({ submitted }) => {
      pickProvider("zai")
      typeInto(control<HTMLInputElement>("Credential"), "sk-pasted")
      pickProvider("openai-oauth")
      submit()
      expect(submitted[0]?.credential).toBeUndefined()
    })
  })
})

describe("AccountFormDialog across a close", () => {
  test("the next account starts empty: the last key is not still in the box", async () => {
    await new Promise<void>((resolve) => {
      withMount(({ setOpen }) => {
        typeInto(control<HTMLInputElement>("Label"), "first")
        pickProvider("zai")
        typeInto(control<HTMLInputElement>("Credential"), "sk-first")
        setOpen(false)
        setOpen(true)
        expect(control<HTMLInputElement>("Label").value).toBe("")
        expect(control<HTMLSelectElement>("Provider").value).toBe("")
        pickProvider("zai")
        expect(control<HTMLInputElement>("Credential").value).toBe("")
        resolve()
      })
    })
  })
})

describe("AccountFormDialog for an API-key provider", () => {
  test("the credential is required, not a 400 after the round trip", () => {
    withMount(() => {
      pickProvider("zai")
      expect(control<HTMLInputElement>("Credential").required).toBe(true)
    })
  })

  test("a login provider asks for no credential at all", () => {
    withMount(() => {
      pickProvider("openai-oauth")
      expect(document.body.querySelector("input[type=password]")).toBeNull()
    })
  })
})

describe("AccountFormDialog for opencode-go", () => {
  test("offers all three surfaces and names the one the default resolves to", () => {
    withMount(() => {
      pickProvider("opencode-go")
      const options = [...control<HTMLSelectElement>("Dialect").options]
      expect(options.map((option) => option.value)).toEqual([
        "",
        "anthropic",
        "openai-chat",
        "openai-responses",
      ])
      expect(options[0]?.textContent).toContain("OpenAI Chat Completions")
    })
  })

  test("the chosen surface is what is submitted", () => {
    withMount(({ submitted }) => {
      pickProvider("opencode-go")
      selectOption(control<HTMLSelectElement>("Dialect"), "anthropic")
      submit()
      expect(submitted[0]?.dialect).toBe("anthropic")
    })
  })

  test("says a personal key is needed before one is pasted", () => {
    withMount(() => {
      pickProvider("opencode-go")
      expect(document.body.textContent).toContain("personal key")
      expect(document.body.textContent).toContain("service-account key")
    })
  })

  test("another provider carries no such note", () => {
    withMount(() => {
      pickProvider("zai")
      expect(document.body.textContent).not.toContain("service-account key")
    })
  })

  test("the option reads the provider's name, not only its id", () => {
    withMount(() => {
      const option = [...control<HTMLSelectElement>("Provider").options].find(
        (candidate) => candidate.value === "opencode-go",
      )
      expect(option?.textContent).toContain("OpenCode Go")
    })
  })
})
