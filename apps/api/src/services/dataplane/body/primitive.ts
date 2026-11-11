import type { Frame } from "./scanner-types"

// DFA states as small integers: string compares per byte made this the scanner's top cost on
// structure-dense bodies (plan 101, 02.1).
const START = 0,
  LITERAL = 1,
  SIGN = 2,
  ZERO = 3,
  INT = 4,
  DOT = 5,
  FRACTION = 6,
  EXP = 7,
  EXP_SIGN = 8,
  EXP_DIGITS = 9

const TRUE = new TextEncoder().encode("true")
const FALSE = new TextEncoder().encode("false")
const NULL = new TextEncoder().encode("null")

export function isWhitespace(b: number): boolean {
  return b === 32 || b === 10 || b === 13 || b === 9
}

/** A byte that ends a number or literal: a separator, a close, or whitespace. */
export function endsPrimitive(b: number): boolean {
  return b === 44 || b === 93 || b === 125 || isWhitespace(b)
}

function isDigit(b: number): boolean {
  return b >= 48 && b <= 57
}

/** JSON literal/number DFA; constant space even for arbitrarily long valid numbers. */
export function createPrimitive() {
  let state = START,
    literal: Uint8Array = TRUE,
    index = 0,
    invalid = false
  return {
    start(b: number) {
      state = START
      index = 0
      invalid = false
      this.byte(b)
    },
    byte(b: number) {
      switch (state) {
        case LITERAL:
          if (b !== literal[index++]) invalid = true
          return
        case START:
          if (b === 116 || b === 102 || b === 110) {
            literal = b === 116 ? TRUE : b === 102 ? FALSE : NULL
            index = 1
            state = LITERAL
          } else if (b === 45) state = SIGN
          else if (b === 48) state = ZERO
          else if (b >= 49 && b <= 57) state = INT
          else invalid = true
          return
        case SIGN:
          if (b === 48) state = ZERO
          else if (b >= 49 && b <= 57) state = INT
          else invalid = true
          return
        case ZERO:
        case INT:
          if (b === 46) state = DOT
          else if (b === 101 || b === 69) state = EXP
          else if (!(isDigit(b) && state === INT)) invalid = true
          return
        case DOT:
          if (isDigit(b)) state = FRACTION
          else invalid = true
          return
        case FRACTION:
          if (b === 101 || b === 69) state = EXP
          else if (!isDigit(b)) invalid = true
          return
        case EXP:
          if (b === 43 || b === 45) state = EXP_SIGN
          else if (isDigit(b)) state = EXP_DIGITS
          else invalid = true
          return
        case EXP_SIGN:
          if (isDigit(b)) state = EXP_DIGITS
          else invalid = true
          return
        default:
          if (!isDigit(b)) invalid = true
      }
    },
    /** The value just finished was the literal `true`. */
    isTrue() {
      return !invalid && state === LITERAL && literal === TRUE && index === 4
    },
    finish() {
      return (
        !invalid &&
        (state === LITERAL
          ? index === literal.length
          : state === ZERO || state === INT || state === FRACTION || state === EXP_DIGITS)
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
