import { type JSX, Show } from "solid-js"
import type { AccountView, ApiKeyView, PoolView } from "../../lib/api/types"
import styles from "./OnboardingPanel.module.scss"

// One step of the onboarding walk, and the line each step reads once it is done. Split from
// `OnboardingPanel`, which owns the dialogs and the walk's state.

/** A key minted in this walk, held while its value is on screen. */
export interface Minted {
  readonly name: string
  readonly value: string
}

interface OnboardingStepProps {
  readonly index: number
  readonly title: string
  readonly done: boolean
  /** What the step reads once it is behind the operator — a count or the one thing they named. */
  readonly doneNote: string
  readonly action: JSX.Element
}

export function OnboardingStep(props: OnboardingStepProps) {
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

export function accountsDoneNote(accounts: readonly AccountView[]): string {
  return accounts.length === 1
    ? `"${accounts[0]?.label ?? ""}" added`
    : `${accounts.length} accounts added`
}

export function poolsDoneNote(pools: readonly PoolView[]): string {
  return pools.length === 1 ? `"${pools[0]?.name ?? ""}" created` : `${pools.length} pools created`
}

/**
 * The mint's own response outruns the keys query it invalidates, so for the beat between the two
 * this step reads its name off the value in hand rather than briefly re-offering the mint button
 * to an operator who has already minted.
 */
export function keysDoneNote(keys: readonly ApiKeyView[], justMinted: Minted | null): string {
  if (keys.length === 0 && justMinted !== null) return `"${justMinted.name}" minted`
  return keys.length === 1 ? `"${keys[0]?.name ?? ""}" minted` : `${keys.length} keys minted`
}
