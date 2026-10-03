import type { AccountRepository, AccountRow, BackgroundAccountSubject } from "@multi-ai-router/db"
import type { Logger } from "../../logging/logger"
import {
  type AsyncBackgroundStartGuard,
  UpstreamAdmissionRefused,
} from "../../providers/upstream-admission"

/** Build before launch waits: only immutable identity fields cross the queued boundary. */
export function createBackgroundStartGuard(
  deps: {
    accounts: Pick<AccountRepository, "readEligibleBackgroundAccount">
    assertWarmEligibility(id: string, expected: BackgroundAccountSubject): void
    logger?: Pick<Logger, "warn">
  },
  subject: BackgroundAccountSubject & { readonly id: string },
  signal?: AbortSignal,
): AsyncBackgroundStartGuard {
  const id = subject.id
  const expected = Object.freeze({
    lifecycleVersion: subject.lifecycleVersion,
    authMaterial: subject.authMaterial,
    provider: subject.provider,
    configDir: subject.configDir,
  })
  const checkCancellation = () => {
    if (signal?.aborted) throw new UpstreamAdmissionRefused("background probe cancelled")
  }
  return async () => {
    checkCancellation()
    let current: AccountRow | undefined
    try {
      current = await deps.accounts.readEligibleBackgroundAccount(id, expected)
    } catch {
      // Fail closed. SQL errors can carry parameters; do not log captured credential material.
      deps.logger?.warn("background account authority unavailable; probe skipped", {
        accountId: id,
      })
      throw new UpstreamAdmissionRefused("background account authority unavailable")
    }
    checkCancellation()
    if (current === undefined)
      throw new UpstreamAdmissionRefused("background account authority changed")
    // The root injects ordinary warm health/quota eligibility; never consume a recovery permit.
    deps.assertWarmEligibility(id, expected)
  }
}
