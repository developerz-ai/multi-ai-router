import { z } from "zod"
import type { ProviderDeviceFlow } from "../../../providers"
import type { CredentialCipher } from "../../crypto/cipher"
import type { DeviceConnectStarted } from "./oauth-device"

/** What the encrypted `nonce` holds for a device attempt. */
const HandleSchema = z.object({
  deviceAuthId: z.string().min(1),
  userCode: z.string().min(1),
  intervalSeconds: z.number().positive(),
})
export type Handle = z.infer<typeof HandleSchema>

export function readDeviceHandle(
  sealed: string,
  cipher: Pick<CredentialCipher, "decrypt">,
): Handle | null {
  try {
    const parsed = HandleSchema.safeParse(JSON.parse(cipher.decrypt(sealed)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export function started(
  accountId: string,
  mode: "connect" | "reconnect",
  device: ProviderDeviceFlow,
  handle: Handle,
  expiresAt: Date,
): DeviceConnectStarted {
  return {
    accountId,
    mode,
    verificationUrl: device.verificationUrl,
    userCode: handle.userCode,
    expiresAt: expiresAt.toISOString(),
    intervalSeconds: handle.intervalSeconds,
  }
}
