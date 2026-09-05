import { createSignal, createUniqueId, For, Show } from "solid-js"
import { Badge } from "../../components/Badge"
import { Button } from "../../components/Button"
import type { ProviderTransport } from "../../lib/api/types"
import styles from "./AccountModels.module.scss"

export interface AccountModelsProps {
  readonly accountId: string
  /** As stored. `null` — or empty — is *unknown*, which the router reads as "accepts anything". */
  readonly models: readonly string[] | null
  readonly busy: boolean
  /** From `GET /providers`: a Claude subscription has no listing endpoint to ask. */
  readonly transport: ProviderTransport | undefined
  readonly onDiscover: (id: string) => void
}

/**
 * What this account serves, and the button that fills it in.
 *
 * **"any model" is not a gap to be nagged about.** An account declaring no set accepts whatever a
 * client names — unknown is passthrough, not exclusion — so the empty state is stated plainly and
 * without a warning tone. What it *does* cost is `GET /v1/models`: the router will not enumerate a
 * catalog it was never told, so a tool filling a model picker from the listing sees nothing. That
 * is the sentence this cell has to get across, and it is why the button sits here rather than in a
 * settings screen.
 *
 * **Discovery is free, so it asks nothing first.** One GET at the provider's own listing bills no
 * tokens and spends no quota window — the opposite of "Test now", which is why that one confirms
 * and this one does not. A Claude subscription is the one account this cannot ask: the Agent SDK
 * owns that catalog, and the button says so rather than failing on a press.
 */
export function AccountModels(props: AccountModelsProps) {
  const declared = (): readonly string[] => props.models ?? []
  const listable = (): boolean => props.transport === "http"
  // The count is the cell; the names are a fold. Seven OpenRouter ids inline is what pushed this
  // column off the right edge of the accounts table.
  const [expanded, setExpanded] = createSignal(false)
  const listId = createUniqueId()

  return (
    <div class={styles.root}>
      {/* Pre-mounted live region, the same shape as ConnectResult: a `role="status"` inserted
          into the DOM together with its own text announces unreliably, so the region wraps the
          slot and a discovery result — the badge/preview swap — lands inside it. */}
      <div class={styles.status} role="status">
        <Show
          fallback={
            <span class={styles.passthrough} title={PASSTHROUGH_HINT}>
              any model
            </span>
          }
          when={declared().length > 0}
        >
          <span class={styles.summary}>
            <Badge title={declared().join("\n")} tone="accent">
              {declared().length} model{declared().length === 1 ? "" : "s"}
            </Badge>{" "}
            <button
              aria-controls={listId}
              aria-expanded={expanded() ? "true" : "false"}
              class={styles.toggle}
              onClick={() => setExpanded(!expanded())}
              type="button"
            >
              {expanded() ? "hide" : "show"}
            </button>
          </span>
          <ul class={styles.list} hidden={!expanded()} id={listId}>
            <For each={declared()}>{(model) => <li>{model}</li>}</For>
          </ul>
        </Show>
      </div>

      <Show
        fallback={
          <span class={styles.note}>
            {props.transport === "agent-sdk"
              ? "The Agent SDK owns this subscription's catalog."
              : "No implementation to ask."}
          </span>
        }
        when={listable()}
      >
        <Button
          busy={props.busy}
          onClick={() => props.onDiscover(props.accountId)}
          size="sm"
          tone="neutral"
        >
          Discover
        </Button>
      </Show>
    </div>
  )
}

const PASSTHROUGH_HINT =
  "This account declares no model set, so it accepts any model name a client sends. It contributes nothing to GET /v1/models until it declares one."
