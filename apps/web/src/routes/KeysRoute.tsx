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
import { routerBaseUrl } from "../lib/onboarding"
import { useAllAccounts } from "../lib/queries/accounts"
import { usePools } from "../lib/queries/pools"
import {
  useCreateKey,
  useDeleteKey,
  useKeys,
  useRevealKey,
  useRevokeKey,
  useUpdateKey,
} from "../lib/queries/router-keys"
import { useSettings } from "../lib/queries/settings"
import { useTableUsage } from "../lib/queries/table-usage"
import styles from "./KeysRoute.module.scss"
import { KeyFormDialog, type KeyFormValues, toCreateKeyInput } from "./keys/KeyFormDialog"
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
 * The value a mint or a reveal returns lives exactly as long as the dialog
 * showing it: closing that dialog drops it from the signal feeding the dialog
 * *and* from the mutation result TanStack parks in its cache. Leaving it there
 * would keep a live credential in memory for the rest of the tab's life for no
 * benefit, since re-reading it is one audited click.
 *
 * Usage rides along as its own query rather than being folded into the keys
 * list: the two have different shapes of staleness — a key row changes when an
 * operator edits it, a usage figure changes every batch flush — and joining them
 * server-side would put an aggregate on the path of every scope edit.
 */
export default function KeysRoute() {
  const now = createNow(30_000)
  const keys = useKeys()
  const pools = usePools()
  const accounts = useAllAccounts()
  const settings = useSettings()

  // The address the snippets tell a client to call. `PUBLIC_URL` wins when the operator set one —
  // this tab's origin can be a private hostname, a port-forward, or an SSH tunnel that no agent
  // machine can resolve. Falls back to the origin, which is right for the common single-host case.
  const baseUrl = () => routerBaseUrl(settings.data?.publicUrl ?? null, window.location.origin)

  const usage = useTableUsage("key")

  const create = useCreateKey()
  const update = useUpdateKey()
  const reveal = useRevealKey()
  const revoke = useRevokeKey()
  const remove = useDeleteKey()

  const [formOpen, setFormOpen] = createSignal(false)
  const [editing, setEditing] = createSignal<ApiKeyView | null>(null)
  const [shown, setShown] = createSignal<ShownKey | null>(null)
  const [pendingRevoke, setPendingRevoke] = createSignal<ApiKeyView | null>(null)
  const [pendingDelete, setPendingDelete] = createSignal<ApiKeyView | null>(null)

  const openForm = (key: ApiKeyView | null) => {
    create.reset()
    update.reset()
    setEditing(key)
    setFormOpen(true)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
  }

  /**
   * Dismissing the value dialog drops the plaintext from both places it landed:
   * this screen's signal, and the mutation result TanStack holds in its cache
   * until the mutation is reset. Which mutation is holding it depends on how the
   * value got here — a mint or a later reveal — and resetting the one that did
   * costs nothing, because neither result is read anywhere else once the dialog
   * is gone.
   */
  const dismissValue = (minted: boolean) => {
    setShown(null)
    if (minted) create.reset()
    else reveal.reset()
  }

  /**
   * The form always states a ceiling and an expiry; a mint drops the `null`s and an
   * edit sends them, because on `PATCH` that is the only way to *remove* either one.
   */
  const submit = (values: KeyFormValues) => {
    const target = editing()
    if (target === null) {
      create.mutate(toCreateKeyInput(values), {
        onSuccess: (key) => {
          closeForm()
          setShown({ name: key.name, value: key.value, minted: true })
        },
      })
      return
    }
    // `KeyFormValues` states every field, which is exactly what `UpdateKeyInput` wants:
    // a `null` ceiling or expiry is a removal, not an omission.
    update.mutate({ id: target.id, patch: values }, { onSuccess: closeForm })
  }

  const mintButton = () => (
    <Button onClick={() => openForm(null)} tone="primary">
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
              onEdit={(key) => openForm(key)}
              onReveal={(key) =>
                reveal.mutate(key.id, {
                  onSuccess: (revealed) =>
                    setShown({ name: revealed.name, value: revealed.value, minted: false }),
                })
              }
              onRevoke={setPendingRevoke}
              revealingId={reveal.isPending ? (reveal.variables ?? null) : null}
              {...usage()}
            />
          </Show>
        )}
      </QueryBoundary>

      <KeyFormDialog
        accounts={accounts.isSuccess ? (accounts.data ?? []) : []}
        apiKey={editing()}
        busy={create.isPending || update.isPending}
        error={editing() === null ? create.error : update.error}
        onClose={closeForm}
        onSubmit={submit}
        open={formOpen()}
        pools={pools.isSuccess ? (pools.data ?? []) : []}
      />

      <Show when={shown()}>
        {(key) => (
          <KeyValueDialog
            baseUrl={baseUrl()}
            minted={key().minted}
            name={key().name}
            onClose={() => dismissValue(key().minted)}
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
