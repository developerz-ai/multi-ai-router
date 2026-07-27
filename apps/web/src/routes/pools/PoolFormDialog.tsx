import type { RoutingPolicy } from "@multi-ai-router/core"
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { Button } from "../../components/Button"
import { SelectField, TextField } from "../../components/Field"
import { Modal } from "../../components/Modal"
import { StatusDot } from "../../components/StatusDot"
import { errorMessage } from "../../lib/api/errors"
import type { CreatePoolInput } from "../../lib/api/pools"
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

/**
 * Which number the chosen policy actually reads. Two of the six are useless without one, and
 * before this the console offered them with nothing to set — so say plainly which box matters.
 */
const TUNING_HINT: Readonly<Record<RoutingPolicy, string>> = {
  sticky: "This policy reads neither number. Both are kept for when you switch policy.",
  "round-robin": "This policy reads neither number. Both are kept for when you switch policy.",
  "least-used": "This policy reads neither number. Both are kept for when you switch policy.",
  "quota-aware": "This policy reads neither number. Both are kept for when you switch policy.",
  weighted:
    "weighted reads weight: a member at 300 gets roughly three times the share of one at 100.",
  "priority-failover":
    "priority-failover reads priority: the lowest number absorbs everything until it filters out, then the next.",
}

/** The membership as the form holds it — both numbers always stated, never left to a default. */
interface MemberDraft {
  readonly accountId: string
  readonly weight: number
  readonly priority: number
}

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
  const [members, setMembers] = createSignal<readonly MemberDraft[]>([])
  const [overflow, setOverflow] = createSignal("")

  // Re-seeded whenever the dialog opens on a different pool. `on` with the
  // pool as its source keeps this a sync-from-props effect and not a place
  // where state is derived.
  //
  // Weight and priority are seeded from the stored membership and re-sent on
  // every save, because `members` replaces the whole set: a form that sent only
  // ids would reset the pool's tuning every time an operator renamed it.
  createEffect(
    on(
      () => (props.open ? props.pool : null),
      (pool) => {
        setName(pool?.name ?? "")
        setPolicy(pool?.policy ?? "sticky")
        setMembers(
          pool?.members.map((member) => ({
            accountId: member.accountId,
            weight: member.weight,
            priority: member.priority,
          })) ?? [],
        )
        setOverflow(pool?.overflowAccountId ?? "")
      },
    ),
  )

  const memberOf = (accountId: string) => members().find((member) => member.accountId === accountId)

  /**
   * The overflow is one of the members, held back from the policy — never a way out of the pool,
   * because a key scoped to this pool must not reach an account the pool does not hold. So the
   * choices are the members, and dropping a member drops the designation with it.
   */
  const overflowChoices = () => props.accounts.filter((account) => memberOf(account.id))
  const overflowValue = () => (memberOf(overflow()) === undefined ? "" : overflow())

  /**
   * A newly added member starts from the account's own weight and priority — the same value the
   * API resolves an omitted field to, so the number on screen is the number that will be stored.
   */
  const toggle = (account: AccountView) => {
    const next =
      memberOf(account.id) === undefined
        ? [
            ...members(),
            { accountId: account.id, weight: account.weight, priority: account.priority },
          ]
        : members().filter((member) => member.accountId !== account.id)
    setMembers(next)
    if (!next.some((member) => member.accountId === overflow())) setOverflow("")
  }

  const tune = (accountId: string, field: "weight" | "priority", raw: string) => {
    // An emptied box is held as-is rather than coerced to 0: `weight: 0` would drop the member
    // out of the weighted policy entirely, which is not what clearing a field means. The number
    // input's own `min`/`step` refuse the submit until it reads a real value again.
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isFinite(parsed)) return
    setMembers(
      members().map((member) =>
        member.accountId === accountId ? { ...member, [field]: parsed } : member,
      ),
    )
  }

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    props.onSubmit({
      name: name().trim(),
      policy: policy(),
      members: members(),
      // Explicitly `null` rather than absent: on an edit that is what clears a pool's overflow.
      overflowAccountId: overflowValue().length > 0 ? overflowValue() : null,
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
                        checked={memberOf(account.id) !== undefined}
                        class={styles.checkbox}
                        onChange={() => toggle(account)}
                        type="checkbox"
                      />
                      <span class={styles.memberName}>{account.label}</span>
                      <span class={styles.memberProvider}>{account.provider}</span>
                      <StatusDot compact status={account.status} />
                    </label>
                    {/* Only for a member: these are properties of the membership, and a number
                        on a row that is not in the pool would be a setting that stores nothing. */}
                    <Show when={memberOf(account.id)}>
                      {(member) => (
                        <div class={styles.tuning}>
                          <TuningInput
                            accountLabel={account.label}
                            field="weight"
                            highlighted={policy() === "weighted"}
                            min={1}
                            onInput={(raw) => tune(account.id, "weight", raw)}
                            value={member().weight}
                          />
                          <TuningInput
                            accountLabel={account.label}
                            field="priority"
                            highlighted={policy() === "priority-failover"}
                            min={0}
                            onInput={(raw) => tune(account.id, "priority", raw)}
                            value={member().priority}
                          />
                        </div>
                      )}
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <p class={styles.hint}>{TUNING_HINT[policy()]}</p>
        </fieldset>

        <SelectField
          hint="One of the members above, held back from the policy until every other member filters out. A key scoped to this pool never reaches an account the pool does not hold, so the overflow cannot be one."
          label="Overflow account"
          onChange={(event) => setOverflow(event.currentTarget.value)}
          options={[
            { value: "", label: members().length === 0 ? "None — add a member first" : "None" },
            ...overflowChoices().map((account) => ({ value: account.id, label: account.label })),
          ]}
          value={overflowValue()}
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

interface TuningInputProps {
  readonly field: "weight" | "priority"
  readonly accountLabel: string
  readonly value: number
  readonly min: number
  /** Marked when the pool's current policy is the one that reads this number. */
  readonly highlighted: boolean
  readonly onInput: (raw: string) => void
}

/**
 * One membership number. Labelled per account rather than per column, because a screen reader
 * lands on "weight" forty times otherwise and none of them say whose.
 */
function TuningInput(props: TuningInputProps) {
  return (
    <label class={styles.tune}>
      <span class={props.highlighted ? styles.tuneLabelActive : styles.tuneLabel}>
        {props.field}
      </span>
      <input
        aria-label={`${props.field} for ${props.accountLabel}`}
        class={styles.number}
        max={10_000}
        min={props.min}
        onInput={(event) => props.onInput(event.currentTarget.value)}
        required
        step={1}
        type="number"
        value={props.value}
      />
    </label>
  )
}
