import type { AccountRepository } from "@multi-ai-router/db"
import {
  createSupportedModelsWriter,
  type SupportedModelsWriter,
} from "../../src/services/accounts"
import type { AuditRecorder } from "../../src/services/admin"

const THIRTY_DAYS_MS = 30 * 86_400_000

/** The production writer over a test repository, for harnesses that build the accounts service. */
export function testSupportedModelsWriter(
  accounts: Pick<AccountRepository, "editSupportedModels">,
  options: { readonly audit?: AuditRecorder; readonly now?: () => Date } = {},
): SupportedModelsWriter {
  return createSupportedModelsWriter({
    accounts,
    audit: options.audit ?? { record: async () => {} },
    now: options.now ?? (() => new Date("2026-11-20T12:00:00.000Z")),
    memoryMs: THIRTY_DAYS_MS,
  })
}
