import type { RoutingPolicy } from "@multi-ai-router/core"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import { StatusDot } from "../../components/StatusDot"
import { errorMessage } from "../../lib/api/errors"
import type { CreatePoolInput, PoolMemberInput } from "../../lib/api/pools"
import type { AccountView, PoolView } from "../../lib/api/types"
import styles from "./PoolFormDialog.module.scss"

/**
 * Presentation order for the six policies, with the one line an operator needs
 * to choose between them. The *vocabulary* is core's `RoutingPolicy`; this is
 * only how each one reads. `sticky` leads because it is the default and the only
 * one unconditionally safe on a pool holding Claude subscription accounts.
 */
const POLICIES: readonly (readonly [RoutingPolicy, string])[] = [
  ["sticky", "sticky — a session keeps its account (default)"],
  ["priority-failover", "priority-failover — strict order, lowest priority first"],
  ["quota-aware", "quota-aware — prefers the account with the most window left"],
  ["least-used", "least-used — fewest in-flight requests"],
  ["round-robin", "round-robin — even rotation"],
  ["weighted", "weighted — biased by each member's weight"],
]

export interface PoolFormDialogProps {
  readonly open: boolean
  /** Absent means create; present means edit that pool. */
  readonly pool: PoolView | null
  readonly accounts: readonly AccountView[]
  readonly busy: boolean
  readonly error: unknown
  readonly onSubmit: (input: CreatePoolInput) => void
  readonly onClose: () => void
}

export function PoolFormDialog(props: PoolFormDialogProps) {
  const [name, setName] = createSignal("")
  const [policy, setPolicy] = createSignal<RoutingPolicy>("sticky")
  const [members, setMembers] = createSignal<readonly string[]>([])
  const [overflow, setOverflow] = createSignal("")

  // Re-seeded whenever the dialog opens on a different pool. `on` with the
  // pool as its source keeps this a sync-from-props effect and not a place
  // where state is derived.
  createEffect(
    on(
      () => (props.open ? props.pool : null),
      (pool) => {
        setName(pool?.name ?? "")
        setPolicy(pool?.policy ?? "sticky")
        setMembers(pool?.members.map((member) => member.accountId) ?? [])
        setOverflow(pool?.overflowAccountId ?? "")
      },
    ),
  )

  const toggle = (accountId: string) => {
    setMembers((current) =>
      current.includes(accountId)
        ? current.filter((id) => id !== accountId)
        : [...current, accountId],
    )
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    const memberInputs: readonly PoolMemberInput[] = members().map((accountId) => ({ accountId }))
    props.onSubmit({
      name: name().trim(),
      policy: policy(),
      members: memberInputs,
      ...(overflow().length > 0 ? { overflowAccountId: overflow() } : {}),
    })
  }

  return (
    <Modal
      description="A pool turns a set of accounts into one addressable thing a key can point at. Membership is replaced as a whole set, so the pool is never briefly half-populated."
      footer={
        <>
          <Button onClick={() => props.onClose()} tone="ghost">
            Cancel
          </Button>
          <Button busy={props.busy} form="pool-form" tone="primary" type="submit">
            {props.pool === null ? "Create pool" : "Save pool"}
          </Button>
        </>
      }
      onClose={() => props.onClose()}
      open={props.open}
      title={props.pool === null ? "New pool" : `Edit ${props.pool.name}`}
    >
      <form class={styles.form} id="pool-form" onSubmit={submit}>
        <TextField
          label="Name"
          onInput={(event) => setName(event.currentTarget.value)}
          required
          value={name()}
        />

        <SelectField
          hint="Only sticky is unconditionally safe on a pool holding Claude subscription accounts — the others ignore the session-to-account binding."
          label="Routing policy"
          onChange={(event) => setPolicy(event.currentTarget.value as RoutingPolicy)}
          options={POLICIES.map(([value, label]) => ({ value, label }))}
          value={policy()}
        />

        <fieldset class={styles.members}>
          <legend class={styles.legend}>Members ({members().length})</legend>
          <Show
            fallback={<p class={styles.empty}>No accounts exist yet — add one first.</p>}
            when={props.accounts.length > 0}
          >
            <ul class={styles.list}>
              <For each={props.accounts}>
                {(account) => (
                  <li class={styles.member}>
                    <label class={styles.memberLabel}>
                      <input
                        checked={members().includes(account.id)}
                        class={styles.checkbox}
                        onChange={() => toggle(account.id)}
                        type="checkbox"
                      />
                      <span class={styles.memberName}>{account.label}</span>
                      <span class={styles.memberProvider}>{account.provider}</span>
                      <StatusDot compact status={account.status} />
                    </label>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </fieldset>

        <SelectField
          hint="The member of last resort — invisible to the policy until the pool filters empty."
          label="Overflow account"
          onChange={(event) => setOverflow(event.currentTarget.value)}
          options={[
            { value: "", label: "None" },
            ...props.accounts.map((account) => ({ value: account.id, label: account.label })),
          ]}
          value={overflow()}
        />

        <Show when={props.error !== undefined && props.error !== null}>
          <p class={styles.error} role="alert">
            {errorMessage(props.error)}
          </p>
        </Show>
      </form>
    </Modal>
  )
}
