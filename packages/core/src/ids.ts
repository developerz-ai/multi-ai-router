/**
 * Router API key format and generation. Pure functions — no I/O, no store, no clock.
 *
 * A key is `mar_live_` + 32 characters drawn from a 64-symbol URL-safe alphabet: 192 bits of
 * CSPRNG entropy, comfortably past the 160-bit floor the spec sets. The fixed literal prefix is
 * what makes a leaked key greppable in a log, a diff, or a secret scanner.
 *
 * Verification never scans: the leading {@link ROUTER_KEY_DISPLAY_PREFIX_LENGTH} characters are
 * stored in clear and indexed, so a presented key costs one indexed lookup, one decrypt, and one
 * constant-time comparison.
 */

/** Fixed, greppable prefix every router key carries. */
export const ROUTER_KEY_PREFIX = "mar_live_"

/** Random characters after the prefix. 32 × 6 bits = 192 bits of entropy. */
export const ROUTER_KEY_RANDOM_LENGTH = 32

/** Random characters retained in the indexed display prefix. */
export const ROUTER_KEY_DISPLAY_RANDOM_LENGTH = 8

/** Length of the clear-stored, indexed display prefix, including {@link ROUTER_KEY_PREFIX}. */
export const ROUTER_KEY_DISPLAY_PREFIX_LENGTH =
  ROUTER_KEY_PREFIX.length + ROUTER_KEY_DISPLAY_RANDOM_LENGTH

/** Full length of a router key. */
export const ROUTER_KEY_LENGTH = ROUTER_KEY_PREFIX.length + ROUTER_KEY_RANDOM_LENGTH

/**
 * 64 symbols exactly. 256 is a whole multiple of 64, so masking a random byte down to its low
 * six bits is uniform — no modulo bias and no rejection loop.
 */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

const ALPHABET_MASK = 0x3f

export const ROUTER_KEY_PATTERN = new RegExp(
  `^${ROUTER_KEY_PREFIX}[A-Za-z0-9_-]{${ROUTER_KEY_RANDOM_LENGTH}}$`,
)

/** Mints a new router key. The only source of key values in the system. */
export function generateRouterKey(): string {
  const bytes = new Uint8Array(ROUTER_KEY_RANDOM_LENGTH)
  crypto.getRandomValues(bytes)
  let random = ""
  for (const byte of bytes) {
    random += ALPHABET.charAt(byte & ALPHABET_MASK)
  }
  return ROUTER_KEY_PREFIX + random
}

/** Shape check only — says nothing about whether the key exists or is revoked. */
export function isRouterKey(value: string): boolean {
  return ROUTER_KEY_PATTERN.test(value)
}

/**
 * The indexed display prefix of a key — the value stored in clear, shown in admin lists, and
 * used to look the row up. Returns `null` for anything that is not a well-formed router key, so
 * a malformed credential never reaches the database as a query parameter.
 */
export function routerKeyDisplayPrefix(value: string): string | null {
  if (!isRouterKey(value)) return null
  return value.slice(0, ROUTER_KEY_DISPLAY_PREFIX_LENGTH)
}
