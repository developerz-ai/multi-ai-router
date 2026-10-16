/**
 * Discord message and embed limits the weekly-report renderer must respect (issue #229).
 *
 * Provenance: Discord developer documentation, "Embed Object — Embed limits"
 * (https://discord.com/developers/docs/resources/message#embed-object-embed-limits) and the
 * message/attachment limits on the same page, read 2026-10-15. Discord rejects an oversized
 * payload with a 400 naming the limit — a terminal delivery failure, so the renderer truncates
 * instead and the numbers are checked at build time: `discord-render.test.ts` asserts each
 * constant against the documented value, so editing one here without editing the documented
 * source fails the build.
 */

/** Sum of every character in every embed of one message. */
export const EMBED_TOTAL_MAX_CHARS = 6000
export const EMBED_TITLE_MAX_CHARS = 256
export const EMBED_DESCRIPTION_MAX_CHARS = 4096
/** Embed fields per embed. */
export const EMBED_FIELDS_MAX = 25
export const EMBED_FIELD_NAME_MAX_CHARS = 256
export const EMBED_FIELD_VALUE_MAX_CHARS = 1024
/** Top-level message `content`; the renderer keeps it empty and puts everything in the embed. */
export const MESSAGE_CONTENT_MAX_CHARS = 2000
/**
 * Incoming-webhook attachment ceiling (25 MiB on a plain webhook). The report CSV is text measured
 * in kilobytes, so this is a sanity bound, not a working limit.
 */
export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024
