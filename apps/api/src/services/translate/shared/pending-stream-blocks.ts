import { translationPendingLimit } from "./responses-snapshot-recovery"

interface Call {
  readonly key: string | number
  id: string | null
  name: string | null
  args: string
  completed: boolean
  chargedBytes: number
}
export type PendingStreamBlock =
  | {
      readonly text: string
      readonly kind: "message" | "reasoning"
      readonly startsNewBlock: boolean
      readonly chargedBytes: number
    }
  | Call

/** Only fragments which cannot enter an already-open Anthropic block wait here. */
export function createPendingStreamBlocks(maximumPendingBytes?: number) {
  const limit = translationPendingLimit(maximumPendingBytes)
  const queue: (PendingStreamBlock | undefined)[] = []
  let head = 0
  const calls = new Map<string | number, Call>()
  let bytes = 0
  function charge(size: number): boolean {
    if (size > limit - bytes) return false
    bytes += size
    return true
  }
  return {
    add(
      key: string | number,
      call: { readonly id?: string | null; readonly name?: string | null },
    ) {
      const id = call.id === "" ? null : (call.id ?? null)
      const name = call.name === "" ? null : (call.name ?? null)
      const old = calls.get(key)
      if (old !== undefined) {
        const extra = `${old.id === null ? (id ?? "") : ""}${old.name === null ? (name ?? "") : ""}`
        const size = Buffer.byteLength(extra, "utf8")
        if (!charge(size)) return false
        old.chargedBytes += size
        old.id ??= id
        old.name ??= name
        return true
      }
      const size = Buffer.byteLength(`${key}${id ?? ""}${name ?? ""}`, "utf8") + 128
      if (!charge(size)) return false
      const item = { key, id, name, args: "", completed: false, chargedBytes: size }
      calls.set(key, item)
      queue.push(item)
      return true
    },
    append(key: string | number, fragment: string) {
      const call = calls.get(key)
      if (call === undefined) return true
      const size = Buffer.byteLength(fragment, "utf8")
      if (!charge(size)) return false
      call.chargedBytes += size
      call.args += fragment
      return true
    },
    text(fragment: string, kind: "message" | "reasoning" = "message", startsNewBlock = false) {
      const last = queue[queue.length - 1]
      const merge = last !== undefined && "text" in last && last.kind === kind && !startsNewBlock
      const size = Buffer.byteLength(fragment, "utf8") + (merge ? 0 : 128)
      if (!charge(size)) return false
      if (merge)
        queue[queue.length - 1] = {
          ...last,
          text: last.text + fragment,
          chargedBytes: last.chargedBytes + size,
        }
      else queue.push({ text: fragment, kind, startsNewBlock, chargedBytes: size })
      return true
    },
    done(key: string | number) {
      const call = calls.get(key)
      if (call !== undefined) call.completed = true
    },
    shift() {
      const item = queue[head]
      if (item === undefined) return undefined
      queue[head++] = undefined
      if (head * 2 >= queue.length) {
        queue.splice(0, head)
        head = 0
      }
      if (!("text" in item)) calls.delete(item.key)
      bytes -= item.chargedBytes
      return item
    },
    drain() {
      const result = queue
        .splice(head)
        .filter((item): item is PendingStreamBlock => item !== undefined)
      queue.length = 0
      head = 0
      calls.clear()
      bytes = 0
      return result
    },
  }
}
