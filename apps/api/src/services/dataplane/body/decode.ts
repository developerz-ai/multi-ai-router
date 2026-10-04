const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
/** Bounded selected strings only: never parse the body or an opening item. */
export function decodeString(bytes: readonly number[]): string {
  const raw = utf8.decode(Uint8Array.from(bytes))
  let out = ""
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charAt(i)
    if (c !== "\\") {
      if (c.charCodeAt(0) < 32) throw Error("control in string")
      out += c
      continue
    }
    const e = raw[++i]
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    }
    if (e !== undefined && simple[e] !== undefined) {
      out += simple[e]
      continue
    }
    if (e !== "u" || !/^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5)))
      throw Error("invalid escape")
    out += String.fromCharCode(Number.parseInt(raw.slice(i + 1, i + 5), 16))
    i += 4
  }
  return out
}
