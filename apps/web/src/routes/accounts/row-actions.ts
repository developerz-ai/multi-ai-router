import type {
  DiscoverModelsResult,
  RecheckResult,
  TestAccountInput,
  TestNowResult,
} from "../../lib/api/accounts"
import {
  useDiscoverAccountModels,
  useRecheckAccount,
  useTestAccount,
} from "../../lib/queries/accounts"
import { createRowRuns } from "../../lib/row-runs"

/** The three presses a row offers, each tracked per account: two rows can run at once. */
export function useAccountRowActions(labelOf: (id: string) => string | undefined) {
  // Named when pressed: a filter changed since hides the account, and that is not a deletion.
  const pressed = new Map<string, string>()
  const name = (id: string) => {
    const label = labelOf(id)
    if (label !== undefined) pressed.set(id, label)
    return label ?? pressed.get(id) ?? id
  }

  const recheck = useRecheckAccount()
  const test = useTestAccount()
  const discover = useDiscoverAccountModels()
  const rechecks = createRowRuns<RecheckResult>()
  const tests = createRowRuns<TestNowResult>()
  const discoveries = createRowRuns<DiscoverModelsResult>()

  return {
    rechecks,
    tests,
    discoveries,
    labelFor: name,
    onRecheck: (id: string) => {
      name(id)
      void rechecks.run(id, () => recheck.mutateAsync(id))
    },
    onTest: (input: TestAccountInput) => {
      name(input.id)
      void tests.run(input.id, () => test.mutateAsync(input))
    },
    onDiscoverModels: (id: string) => {
      name(id)
      void discoveries.run(id, () => discover.mutateAsync(id))
    },
  }
}
