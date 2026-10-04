/** Candidate prefix stays bounded even when role arrives after megabytes of content. */
export function createOpeningCapture(limit: number) {
  let buffer: Uint8Array<ArrayBuffer> | null = null
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
      this.bytes = buffer
      this.bytes[0] = byte
      this.length = 1
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
      if (this.bytes !== null && this.length < limit) this.bytes[this.length++] = byte
    },
    snapshot() {
      return this.prefix.slice(0, this.prefixLength)
    },
    finish() {
      if (this.role === "user" && this.usable) {
        this.prefix = this.bytes ?? new Uint8Array(0)
        this.prefixLength = this.length
        this.done = true
      }
      this.bytes = null
      this.role = null
    },
  }
}
