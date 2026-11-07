/**
 * OpenCode's shared inference backend is full, not the member's quota window.
 * Provenance: Go production 2026-11-07: `[overloaded] the server is overloaded` at 00:22–01:56Z,
 * then `[prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)` at 14:56,
 * 15:06 and 15:07Z. The latter fell through to the 429 default and cooled an otherwise usable
 * seat, causing subsequent requests to be refused without reaching upstream.
 *
 * Both OpenCode drivers share this backend vocabulary. Match its explicit tags (plus the older
 * overload sentence), never generic "capacity" or "limit": `Go usage limit exceeded` and
 * `FreeUsageLimitError` remain actual rate limits. Blast radius: matched failures retry with the
 * existing overload budget, never cool the account, and become 503 rather than quota_exhausted.
 */
export const OPENCODE_OVERLOADED = /\[(?:overloaded|prefill_cap_refused)\]|server is overloaded/i
