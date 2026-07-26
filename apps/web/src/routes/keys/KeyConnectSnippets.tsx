import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js"
import { CopyValue } from "../../components/CopyValue"
import { type ClientRecipe, clientRecipes } from "../../lib/client-snippets"
import styles from "./KeyConnectSnippets.module.scss"

export interface KeyConnectSnippetsProps {
  /** The router's own address — `PUBLIC_URL` when set, otherwise this tab's origin. */
  readonly baseUrl: string
  readonly keyValue: string
  /** Names the key in each copy control's label, so a screen reader hears which key it is. */
  readonly keyName: string
}

/**
 * What to do with the key that is on screen, per client, without leaving the console.
 *
 * The recipes are pre-filled with the operator's **real** base URL and the key's **real** value —
 * a snippet with `YOUR_KEY_HERE` in it is a snippet that gets pasted with `YOUR_KEY_HERE` in it.
 * That is safe here and only here: this renders inside the key's own dialog, on the authenticated
 * admin plane, where the value is already shown in full by design (keys are encrypted at rest and
 * retrievable, never hashed).
 *
 * Tabs rather than six stacked blocks: an operator uses one client, and scrolling past five wrong
 * ones to reach it is how a panel like this stops being read. Selection follows focus (arrow keys
 * activate, per the ARIA tabs pattern) — the panels are pure text, so there is nothing expensive to
 * activate accidentally.
 */
export function KeyConnectSnippets(props: KeyConnectSnippetsProps) {
  const uid = createUniqueId()
  const recipes = createMemo(() => clientRecipes(props.baseUrl, props.keyValue))
  const [selected, setSelected] = createSignal(0)

  // Clamped rather than trusted: `selected` outlives a change to the recipe list.
  const active = createMemo<ClientRecipe | undefined>(() => recipes()[selected()] ?? recipes()[0])

  const tabs: HTMLButtonElement[] = []
  const tabId = (index: number) => `${uid}-tab-${index}`
  const panelId = (index: number) => `${uid}-panel-${index}`

  const move = (to: number) => {
    const count = recipes().length
    if (count === 0) return
    const next = ((to % count) + count) % count
    setSelected(next)
    tabs[next]?.focus()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    const handled: Readonly<Record<string, number>> = {
      ArrowLeft: selected() - 1,
      ArrowRight: selected() + 1,
      Home: 0,
      End: recipes().length - 1,
    }
    const to = handled[event.key]
    if (to === undefined) return
    event.preventDefault()
    move(to)
  }

  return (
    <section class={styles.root}>
      <h3 class={styles.title}>Point your tool at it</h3>
      <p class={styles.lead}>
        The router speaks both dialects on one address. Pick the client and copy the block — the
        base URL and key below are this deployment's real values.
      </p>

      <div aria-label="Client" class={styles.tablist} role="tablist">
        <For each={recipes()}>
          {(recipe, index) => (
            <button
              aria-controls={panelId(index())}
              aria-selected={selected() === index()}
              class={styles.tab}
              id={tabId(index())}
              onClick={() => setSelected(index())}
              onKeyDown={onKeyDown}
              ref={(element) => {
                tabs[index()] = element
              }}
              role="tab"
              tabindex={selected() === index() ? 0 : -1}
              type="button"
            >
              {recipe.label}
            </button>
          )}
        </For>
      </div>

      <Show when={active()}>
        {(recipe) => (
          <div
            aria-labelledby={tabId(selected())}
            class={styles.panel}
            id={panelId(selected())}
            role="tabpanel"
          >
            <p class={styles.panelLead}>{recipe().lead}</p>

            <Show when={recipe().steps.length > 0}>
              <ol class={styles.steps}>
                <For each={recipe().steps}>{(step) => <li>{step}</li>}</For>
              </ol>
            </Show>

            <For each={recipe().snippets}>
              {(snippet) => (
                <div class={styles.snippet}>
                  <p class={styles.snippetLabel}>{snippet.label}</p>
                  <CopyValue
                    label={`${snippet.label} — ${recipe().label} configuration for router key ${props.keyName}`}
                    multiline
                    value={snippet.text}
                  />
                </div>
              )}
            </For>

            <Show when={recipe().caveat}>
              {(caveat) => <p class={styles.caveat}>{caveat()}</p>}
            </Show>
          </div>
        )}
      </Show>
    </section>
  )
}
