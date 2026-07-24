import { createHash, timingSafeEqual } from "node:crypto"

/**
 * Constant-time comparison for secrets of *unequal* length.
 *
 * `crypto.timingSafeEqual` throws when the two buffers differ in size, and length-checking first
 * leaks the length of the expected value. Comparing SHA-256 digests instead makes both operands
 * 32 bytes by construction: the comparison is constant-time in the inputs, and the digest step
 * costs microseconds against the milliseconds argon2 spends next to it.
 */
export function timingSafeEqualStrings(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b))
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest()
}
