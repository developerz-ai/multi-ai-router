/**
 * The `signature` this router stamps on an Anthropic `thinking` block it **synthesized** from
 * another dialect's reasoning summary (openai-responses → anthropic).
 *
 * Anthropic's own signatures are minted by Anthropic and this router cannot produce one. The block
 * still needs *a* signature to be a well-formed `thinking` block, so it carries a versioned tag that
 * names its origin and nothing else: no key, no account id, no upstream handle. A client that
 * replays the block on its next turn is replaying a label, never state.
 *
 * Every `anthropic → X` request translator drops `thinking` blocks before they reach a non-Anthropic
 * upstream, so a tagged block never travels onward through a translation. The one route it can
 * still take is same-dialect passthrough to a real Anthropic upstream — the body is not parsed there
 * (non-negotiable 10), and Anthropic refuses a signature it did not mint. That is a client switching
 * a conversation from an OpenAI-backed model to an Anthropic one mid-transcript, and is stated in
 * `docs/idea/06-protocol-translation.md#known-lossy-edges`.
 */
export const ROUTER_THINKING_SIGNATURE = "mar1:"
