import { createHttpDriver } from "../driver"
import type { ClassificationRule } from "../failure/classify"
import { genericCreditsRule, throttleStatusRule } from "./compatible-rules"

/**
 * `ollama` — a local (or self-hosted) Ollama on its OpenAI-compatible surface, and the one provider
 * here that **authenticates nobody**. `authKind: "none"` is what lets an Account exist with no
 * credential at all: a box on the operator's own network has no key to paste, and demanding one
 * would mean inventing a secret to satisfy a form.
 *
 * A credential is still *accepted*, because the same endpoint is routinely put behind a reverse
 * proxy that does check one, and Ollama's own hosted models take a key. Supply one and it goes up
 * as `Authorization: Bearer`; leave it out and the request carries no auth header (`driver.ts`).
 *
 * **No pinned base URL**, deliberately. Ollama listens on `http://localhost:11434` by default, but
 * this router usually runs in a container where `localhost` is the *router* — a pinned loopback
 * default would address the wrong machine and fail as a connection refused nobody can read. The
 * operator states the address (`http://host.docker.internal:11434/v1`, `http://ollama:11434/v1`, a
 * remote box, a hosted surface), and that is also what makes every one of those work unchanged.
 *
 * What this buys over an `openai-compatible` Account: a credential-free account, an id that names
 * the upstream in usage breakdowns and pool membership, and the one failure below said in Ollama's
 * own words rather than as a bare status.
 */

/**
 * Provenance: Ollama's OpenAI-compatibility layer answers a model it has not pulled with **HTTP 404**
 * and this message (`model "llama3.2" not found, try pulling it first`). Blast radius: the signal
 * recorded on the usage row and shown to the operator. The *verdict* is unchanged — `invalid-request`
 * is what a 404 already means here, and that is deliberate: the honest answer to "this node does not
 * have that model" is the upstream's own error, not a silent retry onto a node that might. A pool of
 * boxes with different model sets is expressed by declaring each Account's models, so routing never
 * offers the request to a node that cannot serve it (docs/idea/05-routing-and-failover.md).
 */
const MODEL_NOT_PULLED = /not found, try pulling it first/i

const modelNotPulledRule: ClassificationRule = {
  kind: "invalid-request",
  signal: "ollama:model-not-pulled",
  when: (facts, status) => status === 404 && MODEL_NOT_PULLED.test(facts.message ?? ""),
}

export const ollamaDriver = createHttpDriver({
  id: "ollama",
  authKind: "none",
  surfaces: [{ dialect: "openai-chat", baseUrl: null }],
  rules: [
    modelNotPulledRule,
    // A local Ollama has no balance to drain, but a hosted or metered surface reached through this
    // id can still refuse one, and its limits are hourly and daily — clock-recoverable. So the
    // throttle guard leads, exactly as it does for the vendors that publish no billing status: a
    // `429` is a cooldown whatever its body says, and only then may wording name a dead balance.
    throttleStatusRule,
    genericCreditsRule,
  ],
})
