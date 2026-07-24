import { createSignal, Show } from "solid-js"
import { Button } from "../components/Button"
import { ConfirmDialog } from "../components/ConfirmDialog"
import { EmptyState } from "../components/EmptyState"
import { PageHeader } from "../components/PageHeader"
import { QueryBoundary } from "../components/QueryBoundary"
import { TableSkeleton } from "../components/TableSkeleton"
import { errorMessage } from "../lib/api/errors"
import type { ApiKeyView } from "../lib/api/types"
import { createNow } from "../lib/clock"
import { useAllAccounts } from "../lib/queries/accounts"
import { usePools } from "../lib/queries/pools"
import {
  useCreateKey,
  useDeleteKey,
  useKeys,
  useRevealKey,
  useRevokeKey,
} from "../lib/queries/router-keys"
import styles from "./KeysRoute.module.scss"
import { KeyFormDialog } from "./keys/KeyFormDialog"
import { KeysTable } from "./keys/KeysTable"
import { KeyValueDialog } from "./keys/KeyValueDialog"

interface ShownKey {
  readonly name: string
  readonly value: string
  readonly minted: boolean
}

/**
 * Router keys: what clients present to reach the router.
 *
 * The load-bearing behaviour on this screen is that a key's **value is viewable
 * and copyable at any time**. Reveal is a `POST` (audited, CSRF-guarded) that
 * decrypts and returns the value; there is no shown-once flow anywhere here and
 * no warning that implies one.
 *
 * The revealed value is held in a component signal and never written to the
 * query cache — caching it would leave a live credential in memory for the rest
 * of the tab's life for no benefit, since re-reading it is one click.
 */
export default function KeysRoute() {
  const now = createNow(30_000)
  const keys = useKeys()
  const pools = usePools()
  const accounts = useAllAccounts()

  const create = useCreateKey()
  const reveal = useRevealKey()
  const revoke = useRevokeKey()
  const remove = useDeleteKey()

  const [minting, setMinting] = createSignal(false)
  const [shown, setShown] = createSignal<ShownKey | null>(null)
  const [pendingRevoke, setPendingRevoke] = createSignal<ApiKeyView | null>(null)
  const [pendingDelete, setPendingDelete] = createSignal<ApiKeyView | null>(null)

  const closeMint = () => {
    create.reset()
    setMinting(false)
  }

  const mintButton = () => (
    <Button onClick={() => setMinting(true)} tone="primary">
      Mint key
    </Button>
  )

  return (
    <>
      <PageHeader
        actions={mintButton()}
        subtitle="Router keys are named and retrievable — view and copy a value at any time, no 'shown once' flow."
        title="Keys"
      />

      <Show when={reveal.isError}>
        <p class={styles.revealError} role="alert">
          {errorMessage(reveal.error)}
        </p>
      </Show>

      <QueryBoundary
        errorTitle="Keys could not be loaded"
        loading={<TableSkeleton label="Loading keys" rows={4} />}
        query={keys}
      >
        {(rows) => (
          <Show
            fallback={
              <EmptyState
                action={mintButton()}
                description="A router key is what a client presents instead of an upstream credential. Mint one per client — per developer, per CI job — so usage is attributable and revoking one breaks exactly one thing."
                icon="keys"
                title="No keys yet"
              />
            }
            when={rows.length > 0}
          >
            <KeysTable
              keys={rows}
              nowMs={now()}
              onDelete={setPendingDelete}
              onReveal={(key) =>
                reveal.mutate(key.id, {
                  onSuccess: (revealed) =>
                    setShown({ name: revealed.name, value: revealed.value, minted: false }),
                })
              }
              onRevoke={setPendingRevoke}
              revealingId={reveal.isPending ? (reveal.variables ?? null) : null}
            />
          </Show>
        )}
      </QueryBoundary>

      <KeyFormDialog
        accounts={accounts.isSuccess ? (accounts.data ?? []) : []}
        busy={create.isPending}
        error={create.error}
        onClose={closeMint}
        onSubmit={(input) =>
          create.mutate(input, {
            onSuccess: (key) => {
              closeMint()
              setShown({ name: key.name, value: key.value, minted: true })
            },
          })
        }
        open={minting()}
        pools={pools.isSuccess ? (pools.data ?? []) : []}
      />

      <Show when={shown()}>
        {(key) => (
          <KeyValueDialog
            minted={key().minted}
            name={key().name}
            onClose={() => setShown(null)}
            open
            value={key().value}
          />
        )}
      </Show>

      <Show when={pendingRevoke()}>
        {(key) => (
          <ConfirmDialog
            busy={revoke.isPending}
            confirmLabel="Revoke key"
            consequences={revokeConsequences(key())}
            error={revoke.error}
            onClose={() => {
              revoke.reset()
              setPendingRevoke(null)
            }}
            onConfirm={() => revoke.mutate(key().id, { onSuccess: () => setPendingRevoke(null) })}
            open
            subject={key().name}
            title="Revoke this key?"
          />
        )}
      </Show>

      <Show when={pendingDelete()}>
        {(key) => (
          <ConfirmDialog
            busy={remove.isPending}
            confirmLabel="Delete key"
            consequences={deleteConsequences(key())}
            error={remove.error}
            onClose={() => {
              remove.reset()
              setPendingDelete(null)
            }}
            onConfirm={() => remove.mutate(key().id, { onSuccess: () => setPendingDelete(null) })}
            open
            subject={key().name}
            title="Delete this key?"
          />
        )}
      </Show>
    </>
  )
}

/** Exactly what breaks — named clients, not "this cannot be undone". */
function revokeConsequences(key: ApiKeyView): readonly string[] {
  return [
    `Every client presenting "${key.name}" starts failing on its next request. In-flight requests finish.`,
    "Revocation is one-way. Mint a replacement and hand it out before revoking, not after.",
    "The key stays listed and its usage history stays attributable.",
  ]
}

function deleteConsequences(key: ApiKeyView): readonly string[] {
  return [
    `"${key.name}" is removed outright — clients presenting it fail immediately.`,
    "Its usage rows survive, but they no longer name a key.",
    "Revoke is the softer door: it stops the key while keeping the row and its scope visible.",
  ]
}
