import { createEffect, createMemo, createSignal, on } from "solid-js"
import type { AccountView, ProviderConnectFlow } from "../../lib/api/types"
import { AccountConnect } from "./AccountConnect"

export interface ReconnectSequenceProps {
  /** The accounts to walk, in order. Captured when the run starts; ids are what is remembered. */
  readonly queue: readonly AccountView[]
  /** The live list, so each step sees the row as it is now — `updatedAt` decides redirect success. */
  readonly accounts: readonly AccountView[]
  readonly connectFlow: ProviderConnectFlow | null
  readonly nowMs: number
  readonly open: boolean
  readonly onClose: () => void
}

/**
 * Six expired subscriptions, one browser login each, walked one at a time.
 *
 * This is **not** a second connect implementation. Each step is the ordinary `AccountConnect` —
 * the same three server calls, the same paste box, the same cancel-on-abandon — handed a step
 * counter and told to start its login on arrival. What this component owns is only the cursor:
 * which account is current, and that Skip and Next both move it. Stop (or Escape) ends the run
 * where it stands; the accounts already reconnected stay reconnected.
 *
 * The queue is remembered by id, not by row: the list underneath refetches after every completed
 * step (the status flips off `needs_reauth`), and a step must keep pointing at the same account
 * through that.
 */
export function ReconnectSequence(props: ReconnectSequenceProps) {
  const [index, setIndex] = createSignal(0)

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open) setIndex(0)
      },
    ),
  )

  const ids = createMemo(() => props.queue.map((account) => account.id))

  const current = createMemo<AccountView | null>(() => {
    if (!props.open) return null
    const id = ids()[index()]
    if (id === undefined) return null
    return props.accounts.find((account) => account.id === id) ?? props.queue[index()] ?? null
  })

  // The cursor goes back to zero on the way out, not only on the way in: `current` is a memo and
  // would otherwise hand the *previous* run's last account to the dialog for one render when the
  // next run opens — long enough for `autoBegin` to start a login on the wrong row.
  const close = () => {
    setIndex(0)
    props.onClose()
  }

  const advance = () => {
    const next = index() + 1
    if (next >= ids().length) close()
    else setIndex(next)
  }

  return (
    <AccountConnect
      account={current()}
      autoBegin
      connectFlow={props.connectFlow}
      nowMs={props.nowMs}
      onClose={close}
      onNext={advance}
      onSkip={advance}
      progress={{ index: Math.min(index() + 1, Math.max(ids().length, 1)), total: ids().length }}
    />
  )
}
