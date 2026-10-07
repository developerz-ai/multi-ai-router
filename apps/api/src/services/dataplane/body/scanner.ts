import { decodeString } from "./decode"
import { createOpaqueArrayRun } from "./opaque-array-run"
import { createOpeningCapture } from "./opening"
import { createPrimitive, finishValue } from "./primitive"
import { validateScannerOptions } from "./scanner-options"
import type { Frame, ScannerOptions, ScanResult } from "./scanner-types"
import { createStringValidation } from "./string-validation"
import { canCloseFrame, consumeSeparator, createFrame } from "./structural"

export * from "./scanner-types"
export function createRoutingScanner(options: ScannerOptions = {}) {
  const { prefixLimit: limit, maximumJsonDepth } = validateScannerOptions(options)
  const stack: Frame[] = []
  let offset = 0,
    inString = false,
    stringStart = 0,
    stringBytes: number[] = [],
    capture = false,
    overlong = false,
    keyString = false
  let rootStarted = false,
    rootFinished = false,
    rejectedRoot = false,
    invalid = false,
    modelSeen = false,
    duplicateModel = false,
    model: string | null = null,
    modelSpan: ScanResult["modelSpan"] = null,
    modelTooLong = false,
    depthExceeded = false
  let finalized = false
  let primitive = false,
    conversationSeen = false
  const strings = createStringValidation(),
    literal = createPrimitive()
  const opening = createOpeningCapture(limit),
    opaqueRun = createOpaqueArrayRun(strings)
  let inputString = false
  const top = () => stack[stack.length - 1]
  function valueDone() {
    rootFinished = finishValue(stack)
  }
  function beginValue(byte: number) {
    const p = top()
    if (!rootStarted) {
      rootStarted = true
      if (byte !== 123) {
        invalid = true
        rejectedRoot = true
        return
      }
    }
    if (p && p.state !== "value" && !(p.kind === "array" && p.state === "first")) {
      invalid = true
      return
    }
    if (byte === 34 && stack.length > 1 && opening.bytes === null && !p?.conversation) {
      inString = true
      strings.reset()
      capture = false
      keyString = false
      overlong = false
      return
    }
    if (p?.kind === "object" && stack.length === 1 && p.key === "model") {
      if (modelSeen) duplicateModel = true
      modelSeen = true
      if (byte !== 34) invalid = true
    }
    const isConversation =
      p?.kind === "object" && stack.length === 1 && (p.key === "messages" || p.key === "input")
    if (isConversation && conversationSeen) invalid = true
    const conversation =
      p?.kind === "object" &&
      stack.length === 1 &&
      (p.key === "messages" || p.key === "input") &&
      !conversationSeen
    if (conversation) conversationSeen = true
    const item = p?.kind === "array" && p.conversation && !opening.done
    if (item && byte === 123) opening.begin(byte, stack.length + 1)
    if (opening.bytes !== null) opening.content(p?.key ?? null, stack.length, byte)
    if (opening.bytes !== null) opening.value(p?.key ?? null, stack.length, byte)
    if (
      (conversation && p?.key === "input" && byte === 34) ||
      (item && p?.conversation && p.input && byte === 34)
    ) {
      opening.directString(stack.length)
      inputString = true
    }
    if (byte === 123 || byte === 91) {
      if (stack.length >= maximumJsonDepth) {
        depthExceeded = true
        invalid = true
        return
      }
      stack.push(createFrame(byte, !!conversation, !!conversation && p?.key === "input"))
      return
    }
    if (byte === 34) {
      inString = true
      strings.reset()
      keyString = false
      stringStart = offset + 1
      overlong = false
      capture =
        !!(p?.key === "model" && stack.length === 1) ||
        !!(opening.bytes !== null && p?.key === "role" && stack.length === opening.depth)
      if (capture) stringBytes = []
      return
    }
    primitive = true
    literal.start(byte)
  }
  function closeString() {
    if (!keyString && !capture && opening.bytes === null) {
      valueDone()
      return
    }
    const p = top()
    let value = ""
    if (capture && !overlong) {
      try {
        value = decodeString(stringBytes)
      } catch {
        invalid = true
      }
    }
    if (keyString) {
      if (!p) {
        invalid = true
        return
      }
      p.key = overlong ? null : value
      if (opening.bytes !== null && stack.length === opening.depth && p.key === "role") {
        if (opening.roleSeen) invalid = true
        opening.roleSeen = true
      }
      p.state = "colon"
    } else {
      if (p?.key === "model" && stack.length === 1 && !duplicateModel) {
        if (overlong || new TextEncoder().encode(value).length > 256) modelTooLong = true
        else {
          model = value
          modelSpan = { start: stringStart, end: offset }
        }
      }
      if (opening.bytes !== null && p?.key === "role" && stack.length === opening.depth)
        opening.role = value
      opening.closeValue(p?.key ?? null, stack.length, offset > stringStart)
      if (inputString) {
        opening.usable = offset > stringStart
        opening.finish()
        inputString = false
      }
      valueDone()
    }
  }
  function finishPrimitive() {
    if (!literal.finish()) invalid = true
    primitive = false
    valueDone()
  }
  return {
    push(chunk: Uint8Array) {
      for (let i = 0; i < chunk.length; i++, offset++) {
        if (
          inString &&
          (!capture || overlong) &&
          !strings.pending &&
          (opening.bytes === null || opening.saturated)
        ) {
          const end = strings.skipString(chunk, i)
          if (end > i) {
            offset += end - i
            i = end
            if (i === chunk.length) break
          }
        }
        const byte = chunk[i] ?? 0
        if (opening.bytes !== null) opening.append(byte)
        if (inString) {
          const closes = strings.byte(byte)
          if (!closes) {
            if (capture && stringBytes.length < 1536) stringBytes.push(byte)
            else if (capture) overlong = true
            continue
          }
          if (byte === 34) {
            inString = false
            closeString()
            continue
          }
          if (byte < 32) invalid = true
          if (capture && stringBytes.length < 1536) stringBytes.push(byte)
          else if (capture) overlong = true
          continue
        }
        if (primitive) {
          if (
            byte !== 44 &&
            byte !== 93 &&
            byte !== 125 &&
            byte !== 32 &&
            byte !== 10 &&
            byte !== 13 &&
            byte !== 9
          ) {
            literal.byte(byte)
            continue
          }
          finishPrimitive()
        }
        if (byte === 32 || byte === 10 || byte === 13 || byte === 9 || rejectedRoot) continue
        if (rootFinished) {
          invalid = true
          continue
        }
        const p = top()
        if (
          byte === 34 &&
          p?.kind === "array" &&
          !p.conversation &&
          opening.bytes === null &&
          (p.state === "first" || p.state === "value")
        ) {
          const after = opaqueRun.scan(chunk, i)
          offset += after - i - 1
          i = after - 1
          inString = opaqueRun.open
          capture = false
          keyString = false
          overlong = false
          if (!inString) valueDone()
          continue
        }
        if (byte === 125 || byte === 93) {
          if (!canCloseFrame(p, byte)) {
            invalid = true
            continue
          }
          if (opening.bytes !== null && byte === 125) opening.closeObject(stack.length)
          opening.closeContainer(stack.length, p.empty)
          if (opening.bytes !== null && stack.length === opening.depth && byte === 125)
            opening.finish()
          stack.pop()
          valueDone()
          continue
        }
        if (byte === 44 || byte === 58) {
          if (!consumeSeparator(p, byte)) invalid = true
          continue
        }
        if (p?.kind === "object" && p.state === "key") {
          if (byte !== 34) {
            invalid = true
            continue
          }
          inString = true
          strings.reset()
          keyString = true
          stringStart = offset + 1
          stringBytes = []
          overlong = false
          capture =
            stack.length === 1 ||
            (opening.bytes !== null &&
              (stack.length === opening.depth || opening.readsKeysAt(stack.length)))
          continue
        }
        beginValue(byte)
      }
    },
    get done() {
      return finalized
    },
    finish() {
      finalized = true
      if (primitive) finishPrimitive()
      if (!rootFinished || stack.length || inString || strings.pending || strings.invalid)
        invalid = true
      return this.result()
    },
    result(): ScanResult {
      return {
        model,
        modelSpan,
        modelTooLong,
        conversationPrefix: opening.snapshot(),
        invalid,
        duplicateModel,
        depthExceeded,
      }
    },
  }
}
