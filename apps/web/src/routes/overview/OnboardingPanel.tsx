import { createMemo, createSignal, type JSX, Show } from "solid-js"
import { Button } from "../../components/Button"
import { CopyValue } from "../../components/CopyValue"
import { EmptyState } from "../../components/EmptyState"
import type { IconName } from "../../components/Icon"
import { findProvider } from "../../lib/api/providers"
import type {
  AccountView,
  ApiKeyView,
  PoolView,
  ProviderConnectFlow,
  ProviderDescriptor,
} from "../../lib/api/types"
import { createNow } from "../../lib/clock"
import { onboardingComplete, routerBaseUrl } from "../../lib/onboarding"
import { useCreateAccount } from "../../lib/queries/accounts"
import { useCreatePool } from "../../lib/queries/pools"
import { useCreateKey } from "../../lib/queries/router-keys"
import { AccountConnect } from "../accounts/AccountConnect"
import { AccountFormDialog } from "../accounts/AccountFormDialog"
import { KeyFormDialog, toCreateKeyInput } from "../keys/KeyFormDialog"
import { PoolFormDialog } from "../pools/PoolFormDialog"
import styles from "./OnboardingPanel.module.scss"

export interface OnboardingPanelProps {
  readonly accounts: readonly AccountView[]
  readonly pools: readonly PoolView[]
  readonly keys: readonly ApiKeyView[]
  readonly providers: readonly ProviderDescriptor[]
  /** The operator's configured `PUBLIC_URL`, or null to fall back to this tab's own origin. */
  readonly publicUrl: string | null
}

interface Minted {
  readonly name: string
  readonly value: string
}

/**
 * The walk from an empty deployment to a working key, in one place.
 *
 * **Always mounted, never externally gated.** `visible` is computed from props — the walk is
 * "done" the instant an account, a pool and a key all exist (`onboardingComplete`) — except for
 * one deliberate override: the moment a key is minted, `minted` is set locally and holds the panel
 * open through the copy-paste block regardless of what the props say next. Without that override,
 * the mint's own success invalidates the keys query, the parent re-renders with `keys.length` now
 * greater than zero, `onboardingComplete` flips true, and a panel gated externally on it would
 * unmount itself out from under the operator before they could copy anything. Mounting this
 * unconditionally and hiding its own content is what lets `minted` survive that.
 *
 * The three creation dialogs are the exact ones `AccountsRoute`/`PoolsRoute`/`KeysRoute` use —
 * this is the same gesture, not a shortcut form, so a provider that needs a login still gets
 * `AccountConnect` afterward rather than being left an unauthorised, unusable row.
 */
export function OnboardingPanel(props: OnboardingPanelProps) {
  const now = createNow()

  const hasAccount = createMemo(() => props.accounts.length > 0)
  const hasPool = createMemo(() => props.pools.length > 0)
  const hasKey = createMemo(() => props.keys.length > 0)

  const complete = createMemo(() =>
    onboardingComplete({
      accounts: props.accounts.length,
      pools: props.pools.length,
      keys: props.keys.length,
    }),
  )

  const [minted, setMinted] = createSignal<Minted | null>(null)
  const visible = createMemo(() => !complete() || minted() !== null)

  const icon = createMemo<IconName>(() => {
    if (!hasAccount()) return "accounts"
    if (!hasPool()) return "pools"
    return "keys"
  })

  const [adding, setAdding] = createSignal(false)
  const [connecting, setConnecting] = createSignal<AccountView | null>(null)
  const [poolOpen, setPoolOpen] = createSignal(false)
  const [keyOpen, setKeyOpen] = createSignal(false)

  const createAccount = useCreateAccount()
  const createPool = useCreatePool()
  const createKey = useCreateKey()

  // Same lookup `AccountsRoute` uses: read off the descriptor, never a list kept here, so a
  // provider that grows a login becomes connectable the day its driver file lands.
  const connectFlowFor = (account: AccountView): ProviderConnectFlow | null =>
    findProvider(props.providers, account.provider)?.connectFlow ?? null

  const connectingFlow = createMemo(() => {
    const account = connecting()
    return account === null ? null : connectFlowFor(account)
  })

  const baseUrl = createMemo(() => routerBaseUrl(props.publicUrl, window.location.origin))

  const closeAdd = () => {
    createAccount.reset()
    setAdding(false)
  }
  const closePool = () => {
    createPool.reset()
    setPoolOpen(false)
  }
  const closeKey = () => {
    createKey.reset()
    setKeyOpen(false)
  }

  return (
    <Show when={visible()}>
      <EmptyState
        action={
          <ol aria-label="Setup steps, in order" class={styles.steps}>
            <OnboardingStep
              action={
                <Button
                  busy={createAccount.isPending}
                  onClick={() => setAdding(true)}
                  tone="primary"
                >
                  Add account
                </Button>
              }
              done={hasAccount()}
              doneNote={accountsDoneNote(props.accounts)}
              index={1}
              title="Add an account"
            />
            <OnboardingStep
              action={
                <Button
                  busy={createPool.isPending}
                  disabled={!hasAccount()}
                  onClick={() => setPoolOpen(true)}
                  tone="primary"
                >
                  New pool
                </Button>
              }
              done={hasPool()}
              doneNote={poolsDoneNote(props.pools)}
              index={2}
              title="Create a pool"
            />

            <li class={styles.step} data-done={hasKey() ? "true" : "false"}>
              <span aria-hidden="true" class={styles.marker}>
                <Show fallback={3} when={hasKey()}>
                  ✓
                </Show>
              </span>
              <div class={styles.body}>
                <p class={styles.title}>Mint a key</p>
                <Show
                  fallback={
                    <Button
                      busy={createKey.isPending}
                      disabled={!hasPool()}
                      onClick={() => setKeyOpen(true)}
                      tone="primary"
                    >
                      Mint key
                    </Button>
                  }
                  when={hasKey()}
                >
                  <Show
                    fallback={<p class={styles.note}>{keysDoneNote(props.keys)}</p>}
                    when={minted()}
                  >
                    {(key) => (
                      <div class={styles.result}>
                        <p class={styles.resultLead}>
                          Live — point any OpenAI- or Anthropic-compatible client at the router:
                        </p>
                        <CopyValue label="Router base URL" value={baseUrl()} />
                        <CopyValue
                          label={`Value of router key ${key().name}`}
                          value={key().value}
                        />
                        <div class={styles.resultActions}>
                          <Button onClick={() => setMinted(null)} tone="primary">
                            Done
                          </Button>
                        </div>
                      </div>
                    )}
                  </Show>
                </Show>
              </div>
            </li>
          </ol>
        }
        description="Add an upstream account, pool it, then mint a key your tools can call — three steps, all of them here."
        icon={icon()}
        title="Get your first working key"
      />

      <AccountFormDialog
        busy={createAccount.isPending}
        error={createAccount.error}
        onClose={closeAdd}
        onSubmit={(input) =>
          createAccount.mutate(input, {
            onSuccess: (account) => {
              closeAdd()
              // Same gesture AccountsRoute offers: a provider with a login lands here
              // unauthorised on purpose, so going straight into Connect finishes it rather
              // than leaving a dead row for the operator to puzzle over later.
              if (connectFlowFor(account) !== null) setConnecting(account)
            },
          })
        }
        open={adding()}
        providers={props.providers}
      />

      <AccountConnect
        account={connecting()}
        connectFlow={connectingFlow()}
        nowMs={now()}
        onClose={() => setConnecting(null)}
      />

      <PoolFormDialog
        accounts={props.accounts}
        busy={createPool.isPending}
        error={createPool.error}
        onClose={closePool}
        onSubmit={(input) => createPool.mutate(input, { onSuccess: closePool })}
        open={poolOpen()}
        pool={null}
      />

      <KeyFormDialog
        accounts={props.accounts}
        apiKey={null}
        busy={createKey.isPending}
        error={createKey.error}
        onClose={closeKey}
        onSubmit={(values) =>
          createKey.mutate(toCreateKeyInput(values), {
            onSuccess: (key) => {
              closeKey()
              setMinted({ name: key.name, value: key.value })
            },
          })
        }
        open={keyOpen()}
        pools={props.pools}
      />
    </Show>
  )
}

interface OnboardingStepProps {
  readonly index: number
  readonly title: string
  readonly done: boolean
  /** What the step reads once it is behind the operator — a count or the one thing they named. */
  readonly doneNote: string
  readonly action: JSX.Element
}

function OnboardingStep(props: OnboardingStepProps) {
  return (
    <li class={styles.step} data-done={props.done ? "true" : "false"}>
      <span aria-hidden="true" class={styles.marker}>
        <Show fallback={props.index} when={props.done}>
          ✓
        </Show>
      </span>
      <div class={styles.body}>
        <p class={styles.title}>{props.title}</p>
        <Show fallback={props.action} when={props.done}>
          <p class={styles.note}>{props.doneNote}</p>
        </Show>
      </div>
    </li>
  )
}

function accountsDoneNote(accounts: readonly AccountView[]): string {
  return accounts.length === 1
    ? `"${accounts[0]?.label ?? ""}" added`
    : `${accounts.length} accounts added`
}

function poolsDoneNote(pools: readonly PoolView[]): string {
  return pools.length === 1 ? `"${pools[0]?.name ?? ""}" created` : `${pools.length} pools created`
}

function keysDoneNote(keys: readonly ApiKeyView[]): string {
  return keys.length === 1 ? `"${keys[0]?.name ?? ""}" minted` : `${keys.length} keys minted`
}
