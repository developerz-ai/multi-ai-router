/**
 * Session lineage for the Claude subscription path (docs/idea/11-anthropic-agent-sdk.md §4).
 *
 * The pieces, smallest first: a **conversation view** that normalizes a request into one hashable
 * string per message, a **fingerprint** that names a headerless client's conversation, a
 * **lineage** classifier that decides whether the incoming messages are a legal descendant of what
 * an SDK session already holds, a **cache** pair with coordinated eviction, and a **store** that
 * puts Postgres behind all of it.
 *
 * Only the store is stateful. Everything else is a pure function, so the six lineage classes are
 * asserted against arrays rather than against a running SDK.
 */

export type { SessionCache, SessionCacheOptions, SessionEntry } from "./cache"
export { createSessionCache } from "./cache"
export type { ConversationView, LineageMessage, LineageRole } from "./conversation"
export { FIRST_USER_TEXT_LIMIT, readConversation } from "./conversation"
export type { FingerprintSeed } from "./fingerprint"
export { scopedKey, sessionFingerprint } from "./fingerprint"
export type {
  FreshReason,
  LineageClass,
  LineageOverlap,
  ResolveLineageInput,
  SessionPlan,
} from "./lineage"
export { classifyLineage, hashMessages, resolveLineage } from "./lineage"
export type {
  ResolveTurnInput,
  SessionStore,
  SessionStoreDeps,
  SessionTurn,
  StoredBinding,
} from "./store"
export {
  createSessionStore,
  DEFAULT_SESSION_CACHE_MAX_ENTRIES,
  DEFAULT_SESSION_CACHE_NEGATIVE_TTL_MS,
  DEFAULT_SESSION_CACHE_TTL_MS,
} from "./store"
