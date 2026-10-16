import { createHash } from "node:crypto"

/** Parse only the public ClientHello structure; never store random/session/key material. */
export function inspectClientHello(record: Uint8Array) {
  const bytes = Buffer.from(record)
  if (bytes[0] !== 22 || bytes[5] !== 1) throw new Error("not a TLS ClientHello record")
  const end = 5 + bytes.readUInt16BE(3)
  if (end > bytes.length) throw new Error("incomplete TLS record")
  let at = 9
  const version = bytes.readUInt16BE(at)
  at += 34 // legacy_version and random
  at += 1 + (bytes[at] ?? 0) // legacy_session_id
  const cipherLength = bytes.readUInt16BE(at)
  at += 2
  const ciphers = u16s(bytes.subarray(at, at + cipherLength)).filter(notGrease)
  at += cipherLength
  at += 1 + (bytes[at] ?? 0) // compression methods
  const extensionLength = bytes.readUInt16BE(at)
  at += 2
  const extensionEnd = at + extensionLength
  if (extensionEnd > end) throw new Error("truncated ClientHello extensions")
  const extensions: number[] = []
  let groups: number[] = []
  let points: number[] = []
  let signatureSchemes: number[] = []
  let supportedVersions: number[] = []
  let keyShareGroups: number[] = []
  let alpn: string[] = []
  while (at + 4 <= extensionEnd) {
    const type = bytes.readUInt16BE(at)
    const length = bytes.readUInt16BE(at + 2)
    at += 4
    if (at + length > extensionEnd) throw new Error("truncated ClientHello extension")
    const value = bytes.subarray(at, at + length)
    at += length
    if (!notGrease(type)) continue
    extensions.push(type)
    if (type === 10) groups = u16s(value.subarray(2)).filter(notGrease)
    if (type === 11) points = [...value.subarray(1)]
    if (type === 13) signatureSchemes = u16s(value.subarray(2)).filter(notGrease)
    if (type === 43) supportedVersions = u16s(value.subarray(1)).filter(notGrease)
    if (type === 16) {
      alpn = []
      for (let i = 2; i < value.length; ) {
        const size = value[i] ?? 0
        alpn.push(value.subarray(i + 1, i + 1 + size).toString("ascii"))
        i += size + 1
      }
    }
    if (type === 51) {
      keyShareGroups = []
      for (let i = 2; i + 4 <= value.length; ) {
        const group = value.readUInt16BE(i)
        const size = value.readUInt16BE(i + 2)
        if (notGrease(group)) keyShareGroups.push(group)
        i += 4 + size
      }
    }
  }
  const ja3 = [
    version,
    ciphers.join("-"),
    extensions.join("-"),
    groups.join("-"),
    points.join("-"),
  ].join(",")
  return {
    version,
    ciphers,
    extensions,
    groups,
    points,
    signatureSchemes,
    supportedVersions,
    keyShareGroups,
    alpn,
    ja3,
    ja3Hash: createHash("md5").update(ja3).digest("hex"),
  }
}
function notGrease(value: number): boolean {
  return !((value & 0x0f0f) === 0x0a0a && value >> 8 === (value & 255))
}
function u16s(bytes: Buffer): number[] {
  const values: number[] = []
  for (let i = 0; i + 2 <= bytes.length; i += 2) values.push(bytes.readUInt16BE(i))
  return values
}
