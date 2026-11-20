import { Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { Button } from "../../components/Button"
import { errorMessage } from "../../lib/api/errors"
import { useEditAccountModels } from "../../lib/queries/accounts"

export interface DiscoverKeptNoticeProps {
  readonly accountId: string
  readonly message: string
  /** Ids on the account's list the catalogue did not carry. Discovery kept every one of them. */
  readonly notInCatalogue: readonly string[]
  /** Clears the discovery's result once its ids are gone: the banner described a list now changed. */
  readonly onRemoved: () => void
}

/**
 * "Discover models" merges: an id the catalogue no longer lists stays on the account until the
 * operator removes it here, on purpose, with one press. A hand-added pinned id is the usual reason
 * one is missing, and silently dropping it refused every request for it (prod 2026-11-15).
 */
export function DiscoverKeptNotice(props: DiscoverKeptNoticeProps) {
  const remove = useEditAccountModels()
  return (
    <>
      <Banner title="Kept: not in the upstream's catalogue" tone="warn">
        {props.message}: {props.notInCatalogue.join(", ")}.{" "}
        <Button
          busy={remove.isPending}
          onClick={() =>
            remove.mutate(
              { id: props.accountId, remove: props.notInCatalogue },
              { onSuccess: props.onRemoved },
            )
          }
          size="sm"
          tone="danger"
        >
          Remove these from the account
        </Button>
      </Banner>
      <Show when={remove.isError}>
        <Banner title="Removing models failed" tone="danger">
          {errorMessage(remove.error)}
        </Banner>
      </Show>
    </>
  )
}
