import { render } from "solid-js/web"
import type { AccountView, ProviderDescriptor } from "../../src/lib/api/types"
import { AccountEditDialog } from "../../src/routes/accounts/AccountEditDialog"
import { fire } from "./dom"

/** Mounting the account edit dialog, and reaching its fields by the words on them. */

export function withMount(props: Parameters<typeof AccountEditDialog>[0], run: () => void): void {
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

export const HTTP_PROVIDER: ProviderDescriptor = {
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
  defaultBilling: "metered",
  billingFixed: false,
}

export const SUBSCRIPTION: ProviderDescriptor = {
  ...HTTP_PROVIDER,
  id: "anthropic-oauth",
  transport: "agent-sdk",
  authKind: null,
  supportedDialects: ["anthropic"],
  requiresConfigDir: true,
  connectFlow: "claude-cli",
  // Sold only as a subscription: there is no per-token price to meter, so the operator cannot say
  // otherwise and the API refuses the write either way.
  defaultBilling: "subscription",
  billingFixed: true,
}

export function account(overrides: Partial<AccountView> = {}): AccountView {
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
    windowTokenLimits: null,
    weight: 300,
    priority: 2,
    billing: "metered",
    tokenExpiresAt: null,
    lastUsedAt: null,
    createdAt: "2026-07-24T12:00:00.000Z",
    updatedAt: "2026-07-24T12:00:00.000Z",
    ...overrides,
  }
}

export function base(overrides: Partial<Parameters<typeof AccountEditDialog>[0]> = {}) {
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

export const fieldByLabel = (text: string): HTMLInputElement => {
  const label = Array.from(document.body.querySelectorAll("label")).find(
    (element) => element.textContent?.trim().startsWith(text) === true,
  )
  const input = label === undefined ? null : document.getElementById(label.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`no input labelled "${text}"`)
  return input
}

export const hasFieldLabelled = (text: string): boolean =>
  Array.from(document.body.querySelectorAll("label")).some(
    (element) => element.textContent?.trim().startsWith(text) === true,
  )

export const aliasBox = (): HTMLTextAreaElement => {
  const box = document.body.querySelector("textarea")
  if (!(box instanceof HTMLTextAreaElement)) throw new Error("no alias textarea")
  return box
}

export function submitForm(): void {
  const form = document.body.querySelector("form")
  if (!(form instanceof HTMLFormElement)) throw new Error("form not rendered")
  fire(form, "submit")
}
