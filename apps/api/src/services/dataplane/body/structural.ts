import type { Frame } from "./scanner-types"
export function createFrame(byte: number, conversation: boolean, input: boolean): Frame {
  return {
    kind: byte === 123 ? "object" : "array",
    state: byte === 123 ? "key" : "first",
    key: null,
    conversation,
    item: false,
    empty: true,
    input,
  }
}
export function canCloseFrame(p: Frame | undefined, byte: number): p is Frame {
  return (
    !!p &&
    (byte === 125) === (p.kind === "object") &&
    (p.state === "comma" ||
      p.state === "first" ||
      (p.kind === "object" && p.state === "key" && p.empty))
  )
}

/** Comma/colon advance only the matching grammar frame; callers still own byte traversal. */
export function consumeSeparator(frame: Frame | undefined, byte: number): boolean {
  if (byte === 44) {
    if (frame?.state !== "comma") return false
    frame.state = frame.kind === "object" ? "key" : "value"
    frame.empty = false
    return true
  }
  if (frame?.kind !== "object" || frame.state !== "colon") return false
  frame.state = "value"
  return true
}
