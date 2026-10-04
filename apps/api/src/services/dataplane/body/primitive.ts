import type { Frame } from "./scanner-types"
/** JSON literal/number DFA; constant space even for arbitrarily long valid numbers. */
export function createPrimitive() {
  let state = "",
    literal = "",
    index = 0,
    invalid = false
  return {
    start(b: number) {
      state = "start"
      literal = ""
      index = 0
      invalid = false
      this.byte(b)
    },
    byte(b: number) {
      const c = String.fromCharCode(b),
        digit = b >= 48 && b <= 57,
        nonzero = b >= 49 && b <= 57
      if (state === "literal") {
        if (c !== literal[index++]) invalid = true
        return
      }
      if (state === "start") {
        if (c === "t" || c === "f" || c === "n") {
          literal = c === "t" ? "true" : c === "f" ? "false" : "null"
          index = 1
          state = "literal"
        } else if (c === "-") state = "sign"
        else if (c === "0") state = "zero"
        else if (nonzero) state = "int"
        else invalid = true
        return
      }
      if (state === "sign") {
        if (c === "0") state = "zero"
        else if (nonzero) state = "int"
        else invalid = true
        return
      }
      if (state === "zero" || state === "int") {
        if (c === ".") state = "dot"
        else if (c === "e" || c === "E") state = "exp"
        else if (digit && state === "int") {
        } else invalid = true
        return
      }
      if (state === "dot") {
        if (digit) state = "fraction"
        else invalid = true
        return
      }
      if (state === "fraction") {
        if (digit) {
        } else if (c === "e" || c === "E") state = "exp"
        else invalid = true
        return
      }
      if (state === "exp") {
        if (c === "+" || c === "-") state = "expSign"
        else if (digit) state = "expDigits"
        else invalid = true
        return
      }
      if (state === "expSign") {
        if (digit) state = "expDigits"
        else invalid = true
        return
      }
      if (state === "expDigits" && !digit) invalid = true
    },
    finish() {
      return (
        !invalid &&
        (state === "literal"
          ? index === literal.length
          : ["zero", "int", "fraction", "expDigits"].includes(state))
      )
    },
  }
}

export function finishValue(stack: Frame[]): boolean {
  const p = stack[stack.length - 1]
  if (!p) return true
  p.state = "comma"
  p.key = null
  p.empty = false
  return false
}
