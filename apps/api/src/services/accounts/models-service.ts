import type { AdminResult } from "../admin/result"
import type { EditSupportedModelsBody, ReplaceSupportedModelsBody } from "./schemas"
import type { SupportedModelsWrite, SupportedModelsWriter } from "./supported-models-writer"

/**
 * The two admin operations on an account's model list, each one call into the one writer:
 * `PATCH /:id/models` adds and removes single ids, `PUT /:id/models` replaces the list and must
 * name what it removes. The answer is the diff, so the console shows what moved.
 */
export interface SupportedModelsView {
  readonly accountId: string
  /** The list after the write; `null` when it declares none (passthrough). */
  readonly supportedModels: readonly string[] | null
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

export interface AccountModelsService {
  edit(accountId: string, body: EditSupportedModelsBody): Promise<AdminResult<SupportedModelsView>>
  replace(
    accountId: string,
    body: ReplaceSupportedModelsBody,
  ): Promise<AdminResult<SupportedModelsView>>
}

export function createAccountModelsService(
  writer: Pick<SupportedModelsWriter, "write">,
): AccountModelsService {
  return {
    edit: async (accountId, body) =>
      view(
        accountId,
        await writer.write(
          accountId,
          { kind: "edit", add: body.add ?? [], remove: body.remove ?? [] },
          "operator-edit",
        ),
      ),
    replace: async (accountId, body) =>
      view(
        accountId,
        await writer.write(
          accountId,
          { kind: "replace", models: body.models, removing: body.removing },
          "operator-replace",
        ),
      ),
  }
}

function view(
  accountId: string,
  written: AdminResult<SupportedModelsWrite>,
): AdminResult<SupportedModelsView> {
  if (!written.ok) return written
  const { change } = written.value
  return {
    ok: true,
    value: {
      accountId,
      supportedModels: change.after,
      added: change.added,
      removed: change.removed,
    },
  }
}
