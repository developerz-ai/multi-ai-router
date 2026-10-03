import type { AccountRepository, BackgroundAccountSubject } from "@multi-ai-router/db"
import type { Logger } from "../logging/logger"
import { UpstreamAdmissionRefused } from "../providers/upstream-admission"
import { createBackgroundStartGuard } from "../services/accounts/background-admission"
import type { RecoveryAccess } from "../services/dataplane/recovery-access"
import type { RoutingCatalog } from "../services/dataplane/types"
import { findSpentWindow } from "../services/routing"
import { recoveryIsGated } from "../services/routing/recovery-filter"

/** Background turns use ordinary eligibility and never spend a designated recovery permit. */
export function createWarmBackgroundStartGuard(
  deps: {
    accounts: Pick<AccountRepository, "readEligibleBackgroundAccount">
    catalog: Pick<RoutingCatalog, "accounts">
    access: Pick<RecoveryAccess, "currentSnapshot">
    now: () => Date
    quotaSpentThreshold: number
    logger?: Pick<Logger, "warn">
    accepting?: () => boolean
  },
  expected: BackgroundAccountSubject & { readonly id: string },
  signal?: AbortSignal,
) {
  const guard = createBackgroundStartGuard(
    {
      accounts: deps.accounts,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
      assertWarmEligibility(id, subject) {
        if (deps.accepting?.() === false)
          throw new UpstreamAdmissionRefused("background admission stopped")
        const account = deps.catalog.accounts().find((candidate) => candidate.id === id)
        const live = deps.access.currentSnapshot(id)
        if (
          account === undefined ||
          live === undefined ||
          account.lifecycleVersion !== subject.lifecycleVersion ||
          account.authMaterial !== subject.authMaterial ||
          account.driver.provider !== subject.provider ||
          account.configDir !== subject.configDir ||
          live.status !== "active" ||
          recoveryIsGated(live) ||
          findSpentWindow(live, deps.now(), deps.quotaSpentThreshold) !== null
        )
          throw new UpstreamAdmissionRefused("background account is not ordinarily eligible")
      },
    },
    expected,
    signal,
  )
  return async () => {
    if (deps.accepting?.() === false)
      throw new UpstreamAdmissionRefused("background admission stopped")
    await guard()
  }
}
