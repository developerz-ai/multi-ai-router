/**
 * A typed line the operator cannot see. With no echo, a key that quietly becomes part of the
 * password is found out only when it does not sign in, so control and escape sequences are either
 * the editing keys they are known for or nothing.
 */
export interface HiddenLineReader {
  /** Feeds decoded terminal input and returns every line it completed. */
  push(text: string): HiddenInput
}

export interface HiddenInput {
  readonly lines: readonly string[]
  /** Ctrl-C, or Ctrl-D on an empty line. */
  readonly aborted: boolean
}

const CTRL_C = "\u0003"
const CTRL_D = "\u0004"
const CTRL_U = "\u0015"
const ESC = "\u001b"

export function createHiddenLineReader(): HiddenLineReader {
  // Code points, so one backspace takes back one character and never half of one.
  let line: string[] = []
  // `escape`: after ESC. `sequence`: inside `ESC [ …` or `ESC O …`, up to its final character.
  let state: "text" | "escape" | "sequence" = "text"
  let afterReturn = false

  return {
    push(text) {
      const lines: string[] = []
      for (const char of text) {
        const pairedNewline = afterReturn && char === "\n"
        afterReturn = char === "\r"
        // Nothing below space continues a sequence, so a lone Escape never eats Enter or Ctrl-C.
        if (char < " ") state = "text"
        if (state === "escape") {
          state = char === "[" || char === "O" ? "sequence" : "text"
        } else if (state === "sequence") {
          if (char >= "@" && char <= "~") state = "text"
        } else if (char === ESC) {
          state = "escape"
        } else if (char === CTRL_C || (char === CTRL_D && line.length === 0)) {
          return { lines, aborted: true }
        } else if (char === "\r" || char === "\n") {
          // A pasted CRLF is one line end, not a line and an empty one.
          if (pairedNewline) continue
          lines.push(line.join(""))
          line = []
        } else if (char === CTRL_U) {
          line = []
        } else if (char === "\u007f" || char === "\b") {
          line.pop()
        } else if (char >= " ") {
          line.push(char)
        }
      }
      return { lines, aborted: false }
    },
  }
}
