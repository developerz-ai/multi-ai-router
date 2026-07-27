import { createMemo, createSignal, type JSX, Show } from "solid-js"
import { Button } from "../../components/Button"
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
import { KeyValueDialog } from "../keys/KeyValueDialog"
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
 * `AccountConnect` afterward rather than being left an unauthorised, unusable row. The mint's
 * payoff is `KeyValueDialog` for the same reason: the fourth step of the walk is *pointing a tool
 * at the thing*, and an operator who arrives here — the one who has never seen this router before —
 * is precisely the one who must not be handed a bare URL and left to guess which clients want the
 * `/v1` suffix. Rebuilding a lesser version of that block here would put the newcomer on the worse
 * surface and the operator who already knows the answer on the better one.
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

  /**
   * Same discipline as `KeysRoute`: the plaintext lives exactly as long as the dialog showing it.
   * Dropping the signal is only half — the mint result sits in TanStack's mutation cache until the
   * mutation is reset, and a mounted screen never detaches an observer on its own.
   */
  const dismissMinted = () => {
    setMinted(null)
    createKey.reset()
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

            <OnboardingStep
              action={
                <Button
                  busy={createKey.isPending}
                  disabled={!hasPool()}
                  onClick={() => setKeyOpen(true)}
                  tone="primary"
                >
                  Mint key
                </Button>
              }
              done={minted() !== null || hasKey()}
              doneNote={keysDoneNote(props.keys, minted())}
              index={3}
              title="Mint a key"
            />
          </ol>
        }
        description="Add an upstream account, pool it, then mint a key — the mint hands you this deployment's base URL and a ready-to-paste block for whichever client you point at it."
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

      {/* The walk's fourth step, and the reason the panel holds itself open past `complete()`. */}
      <Show when={minted()}>
        {(key) => (
          <KeyValueDialog
            baseUrl={baseUrl()}
            minted
            name={key().name}
            onClose={dismissMinted}
            open
            value={key().value}
          />
        )}
      </Show>
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

/**
 * The mint's own response outruns the keys query it invalidates, so for the beat between the two
 * this step reads its name off the value in hand rather than briefly re-offering the mint button
 * to an operator who has already minted.
 */
function keysDoneNote(keys: readonly ApiKeyView[], justMinted: Minted | null): string {
  if (keys.length === 0 && justMinted !== null) return `"${justMinted.name}" minted`
  return keys.length === 1 ? `"${keys[0]?.name ?? ""}" minted` : `${keys.length} keys minted`
}
