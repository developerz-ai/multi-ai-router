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
export function useAccountRowActions() {
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
    onRecheck: (id: string) => void rechecks.run(id, () => recheck.mutateAsync(id)),
    onTest: (input: TestAccountInput) => void tests.run(input.id, () => test.mutateAsync(input)),
    onDiscoverModels: (id: string) => void discoveries.run(id, () => discover.mutateAsync(id)),
  }
}
