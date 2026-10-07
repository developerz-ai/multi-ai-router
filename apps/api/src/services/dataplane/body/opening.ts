/**
 * What opens a client-injected reminder block. Claude Code leads every opening user message — the
 * main conversation's and each subagent's alike — with `<system-reminder>` text blocks (git status,
 * project instructions, attribution) that are identical across every conversation in one CLI
 * session and routinely longer than the whole prefix window. Captured raw, the window held nothing
 * but reminder bytes, so a parent and five parallel subagents hashed to one session key and
 * trampled one another's SDK lineage (captured from CLI 2.1.292 on a stub upstream, 2026-10-07).
 * Meridian strips the same blocks before fingerprinting for the same reason.
 */
const REMINDER = new TextEncoder().encode("<system-reminder>")

/** Candidate prefix stays bounded even when role arrives after megabytes of content. */
export function createOpeningCapture(limit: number) {
  let buffer: Uint8Array<ArrayBuffer> | null = null
  let filtered: Uint8Array<ArrayBuffer> | null = null
  // The same window with reminder blocks cut out. Used only when it dropped one and kept another:
  // an opening without reminders keeps its raw bytes, so every other client's key is unchanged,
  // and an opening that is nothing but reminders falls back to them rather than hashing nothing.
  let filteredLength = 0,
    blockOpen = false,
    blockStart = 0,
    blockReminder = false,
    probe = -1,
    dropped = false,
    kept = false
  return {
    bytes: null as Uint8Array<ArrayBuffer> | null,
    length: 0,
    prefixLength: 0,
    depth: 0,
    role: null as string | null,
    prefix: new Uint8Array(0),
    done: false,
    roleSeen: false,
    usable: false,
    contentDepth: 0,
    begin(byte: number, depth: number) {
      buffer ??= new Uint8Array(limit)
      filtered ??= new Uint8Array(limit)
      this.bytes = buffer
      this.bytes[0] = byte
      filtered[0] = byte
      this.length = 1
      filteredLength = 1
      blockOpen = blockReminder = dropped = kept = false
      probe = -1
      this.depth = depth
      this.role = null
      this.roleSeen = false
      this.usable = false
      this.contentDepth = 0
    },
    directString(depth: number) {
      this.begin(34, depth)
      this.role = "user"
    },
    content(key: string | null, depth: number, byte: number) {
      if (this.bytes !== null && depth === this.depth && key === "content" && byte === 91)
        this.contentDepth = depth + 1
    },
    /** A value begins at `depth`; an object directly inside the content array is a block. */
    value(key: string | null, depth: number, byte: number) {
      if (this.bytes === null || this.contentDepth === 0) return
      if (byte === 123 && depth === this.contentDepth) {
        blockOpen = true
        blockReminder = false
        blockStart = filteredLength - 1
      } else if (byte === 34 && blockOpen && depth === this.contentDepth + 1 && key === "text") {
        probe = 0
      }
    },
    /** Block-level keys are decoded so a block's `text` value can be recognised. */
    readsKeysAt(depth: number) {
      return blockOpen && depth === this.contentDepth + 1
    },
    /** An object closes at `depth`; a reminder block is cut from the filtered window. */
    closeObject(depth: number) {
      if (!blockOpen || depth !== this.contentDepth + 1) return
      blockOpen = false
      probe = -1
      if (blockReminder) {
        filteredLength = blockStart
        dropped = true
      } else kept = true
      blockReminder = false
    },
    closeValue(key: string | null, depth: number, nonempty: boolean) {
      if (this.bytes !== null && depth === this.depth && key === "content") this.usable = nonempty
    },
    closeContainer(depth: number, empty: boolean) {
      if (depth === this.contentDepth) {
        this.usable = !empty
        this.contentDepth = 0
      }
    },
    append(byte: number) {
      if (this.bytes === null) return
      if (this.length < limit) this.bytes[this.length++] = byte
      if (filtered !== null && filteredLength < limit) filtered[filteredLength++] = byte
      if (probe < 0) return
      if (byte !== REMINDER[probe]) probe = -1
      else if (++probe === REMINDER.length) {
        blockReminder = true
        probe = -1
      }
    },
    /** True once no further string byte can change either window, so strings may be skipped. */
    get saturated() {
      return this.length >= limit && probe < 0 && (filteredLength >= limit || blockReminder)
    },
    snapshot() {
      return this.prefix.slice(0, this.prefixLength)
    },
    finish() {
      if (this.role === "user" && this.usable) {
        const cut = dropped && kept && filtered !== null
        this.prefix = (cut ? filtered : this.bytes) ?? new Uint8Array(0)
        this.prefixLength = cut ? filteredLength : this.length
        this.done = true
      }
      this.bytes = null
      this.role = null
    },
  }
}
