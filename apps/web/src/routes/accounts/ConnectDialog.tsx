import { createEffect, createMemo, createSignal, createUniqueId, Show } from "solid-js"
import { Banner } from "../../components/Banner"
import { Button } from "../../components/Button"
import { CopyValue } from "../../components/CopyValue"
import { Field } from "../../components/Field"
import { Modal } from "../../components/Modal"
import type { ConnectCompleted, ConnectMode, ConnectStarted } from "../../lib/api/connect"
import { errorMessage } from "../../lib/api/errors"
import type { AccountView, ProviderConnectFlow } from "../../lib/api/types"
import {
  classifyPaste,
  connectExpiry,
  describePasteShape,
  isSubmittablePaste,
} from "../../lib/connect-capture"
import { formatAbsolute } from "../../lib/reset-countdown"
import styles from "./ConnectDialog.module.scss"
import { ConnectResult } from "./ConnectResult"

export interface ConnectDialogProps {
  readonly open: boolean
  /** Null while no account is selected — the dialog renders nothing. */
  readonly account: AccountView | null
  /** `claude-cli` drives the CLI; `oauth` is a code flow the router runs. Null → not connectable. */
  readonly connectFlow: ProviderConnectFlow | null
  readonly mode: ConnectMode
  readonly started: ConnectStarted | null
  readonly completed: ConnectCompleted | null
  readonly beginning: boolean
  readonly completing: boolean
  readonly error: unknown
  readonly nowMs: number
  readonly onBegin: () => void
  readonly onComplete: (pasted: string) => void
  readonly onClose: () => void
}

/**
 * Logging one Account in — and re-authorising it, which is the same dialog against the same row.
 *
 * **Both capture modes, and paste is presented first.** Not a fallback and never worded as one:
 * paste is the only mode that works when the router has no reachable `PUBLIC_URL`, and the only
 * mode the `claude` CLI login has at all (docs/idea/03-providers.md). Redirect is the shortcut
 * offered when the server minted a callback it can actually receive — and the paste box stays live
 * underneath it, because a callback the browser cannot load still leaves the value in the address
 * bar.
 *
 * **The pasted value is write-only.** It is an authorization code: it lives in one signal for as
 * long as this dialog is open, goes straight to `onComplete`, and is echoed nowhere — not into the
 * feedback line, not into a `title`, not into an error. `connect-capture.ts` classifies it by shape
 * so the operator gets a live "that is not one of the three shapes" before a one-shot login is
 * spent, and that classification never quotes what it read.
 *
 * Nothing in `ConnectStarted` carries credential material — `authorizeUrl` is a public URL the
 * operator is meant to open, and that is the whole payload.
 */
export function ConnectDialog(props: ConnectDialogProps) {
  const [pasted, setPasted] = createSignal("")
  const feedbackId = createUniqueId()
  const formId = createUniqueId()

  // Dropped the moment the dialog closes or the login lands. The mutation keeps its own copy of the
  // last submitted value until `AccountConnect` resets it on close — by then the code is spent, but
  // the two are cleared on the same gesture rather than one outliving the other indefinitely.
  createEffect(() => {
    if (!props.open || props.completed !== null) setPasted("")
  })

  const pending = createMemo(() => (props.completed === null ? props.started : null))
  const expiry = createMemo(() => {
    const started = pending()
    return started === null ? null : connectExpiry(started.expiresAt, props.nowMs)
  })
  // Absolute time *and* countdown, the pair every deadline in this console is stated as: a tab left
  // open makes "4m left" a lie, and a bare timestamp makes the operator do the arithmetic.
  const expiryLine = () => {
    const started = pending()
    const deadline = expiry()
    if (started === null || deadline === null) return ""
    if (deadline.expired) return "One-shot — this login has expired."

    const at = Date.parse(started.expiresAt)
    return Number.isNaN(at)
      ? `One-shot — ${deadline.remaining} left.`
      : `One-shot — expires ${formatAbsolute(at)} (${deadline.remaining} left).`
  }

  const live = () => pending() !== null && expiry()?.expired !== true
  const reconnect = () => props.mode === "reconnect"
  const submittable = () => isSubmittablePaste(pasted())
  const startLabel = () => {
    if (pending() !== null) return "Start again"
    return reconnect() ? "Start re-authorization" : "Start login"
  }

  // Stated as the mechanism this flow has, never as a degraded fallback — it is the mode that
  // requires nothing of the router to be reachable from the internet.
  const pasteOnlyReason = () =>
    props.connectFlow === "claude-cli"
      ? "The CLI owns its own redirect, so there is no router callback to intercept."
      : "The router has no public address a provider callback could be delivered to, and this mode needs none."

  const submit = (event: SubmitEvent) => {
    event.preventDefault()
    if (submittable()) props.onComplete(pasted())
  }

  return (
    <Show when={props.account}>
      {(account) => (
        <Modal
          description={
            reconnect()
              ? `${account().label} · ${account().provider} — the same row throughout: id, config directory, pool membership and usage history all survive.`
              : `${account().label} · ${account().provider}`
          }
          footer={
            <>
              <Button onClick={() => props.onClose()} tone="ghost">
                {props.completed === null && props.connectFlow !== null ? "Cancel" : "Close"}
              </Button>
              <Show when={props.connectFlow !== null && props.completed === null}>
                <Show
                  fallback={
                    <Button busy={props.beginning} onClick={() => props.onBegin()} tone="primary">
                      {startLabel()}
                    </Button>
                  }
                  when={live()}
                >
                  <Button
                    busy={props.completing}
                    disabled={!submittable()}
                    form={formId}
                    tone="primary"
                    type="submit"
                  >
                    Complete login
                  </Button>
                </Show>
              </Show>
            </>
          }
          onClose={() => props.onClose()}
          open={props.open}
          title={reconnect() ? "Re-authorize account" : "Connect account"}
        >
          <Show when={props.connectFlow === null}>
            <Banner title="This provider takes a key, not a login" tone="info">
              <p>
                There is no authorization flow to run here. The credential is supplied on the
                account itself, encrypted at rest, and never returned by any endpoint.
              </p>
            </Banner>
          </Show>

          <Show when={props.connectFlow !== null && pending() === null && props.completed === null}>
            <section class={styles.note}>
              <Show
                fallback={
                  <p>
                    The router runs the authorization-code exchange itself and stores only the
                    credential it buys, encrypted at rest. No code, <code>state</code>, verifier or
                    token is ever returned to this console.
                  </p>
                }
                when={props.connectFlow === "claude-cli"}
              >
                <p>
                  The login runs through the <code>claude</code> CLI against this account's own{" "}
                  <code>CLAUDE_CONFIG_DIR</code>. The CLI performs the exchange and writes its own
                  credentials there — the router never sees or stores the token.
                </p>
              </Show>
            </section>
          </Show>

          <Show when={pending()}>
            {(started) => (
              <>
                <section class={styles.section}>
                  <h3 class={styles.sectionTitle}>Authorize</h3>
                  <p class={styles.hint}>
                    Open this in a browser signed in to the account you are attaching.
                  </p>
                  <CopyValue label="Authorization URL" value={started().authorizeUrl} />
                  <a
                    class={styles.open}
                    href={started().authorizeUrl}
                    rel="noreferrer"
                    target="_blank"
                  >
                    Open in a new tab
                  </a>
                  <p class={styles.expiry}>{expiryLine()}</p>
                </section>

                <Show when={expiry()?.expired === true}>
                  <Banner title="This login has expired" tone="warn">
                    <p>
                      The one-shot value was spent or timed out, so there is nothing left to paste
                      into. Start again for a fresh authorization URL.
                    </p>
                  </Banner>
                </Show>

                <Show when={live()}>
                  <section class={styles.section}>
                    <h3 class={styles.sectionTitle}>Paste what you get back</h3>
                    <form id={formId} onSubmit={submit}>
                      <Field
                        hint="The whole callback URL, its query string, or the code#state shorthand — unedited."
                        label="Authorization result"
                      >
                        {(ids) => (
                          <textarea
                            aria-describedby={`${ids.describedBy} ${feedbackId}`}
                            autocomplete="off"
                            class={styles.paste}
                            id={ids.id}
                            onInput={(event) => setPasted(event.currentTarget.value)}
                            rows={3}
                            spellcheck={false}
                            value={pasted()}
                          />
                        )}
                      </Field>
                    </form>
                    {/* Described-by and nothing more. A live region here would re-announce the
                        whole sentence on every keystroke of a value that is pasted, not typed. */}
                    <p class={styles.feedback} id={feedbackId}>
                      {describePasteShape(classifyPaste(pasted()))}
                    </p>
                  </section>

                  <Show when={started().capture === "paste"}>
                    <p class={styles.note}>
                      Paste is the capture mode for this login. {pasteOnlyReason()} It is the mode
                      every check on this flow is written against.
                    </p>
                  </Show>

                  <Show when={started().capture === "redirect" ? started().redirectUri : undefined}>
                    {(redirectUri) => (
                      <section class={styles.section}>
                        <h3 class={styles.sectionTitle}>Or let the browser come back</h3>
                        <p class={styles.hint}>
                          The provider lands the browser back on the router at this address and the
                          exchange happens there, not in this tab — so leave this dialog open and it
                          will notice on its own within a few seconds.
                        </p>
                        <CopyValue label="Redirect URI" value={redirectUri()} />
                        <p class={styles.hint}>
                          The box above stays live either way: a callback the browser cannot load
                          still leaves the value in the address bar.
                        </p>
                      </section>
                    )}
                  </Show>
                </Show>
              </>
            )}
          </Show>

          <ConnectResult completed={props.completed} mode={props.mode} />

          <Show when={props.error !== undefined && props.error !== null}>
            <p class={styles.error} role="alert">
              {errorMessage(props.error)}
            </p>
          </Show>
        </Modal>
      )}
    </Show>
  )
}
