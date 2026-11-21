import type { SpawnedProcess, SpawnOptions } from "@anthropic-ai/claude-agent-sdk"

export interface OwnerLaunchConfig {
  readonly helperPath: string
  readonly root: string
  readonly maximumOwners: number
  readonly termGraceMs: number
  readonly pollMs: number
  readonly maximumChildren: number
  readonly admissionTimeoutMs: number
}
export interface OwnerLaunch {
  readonly spawn: (input: SpawnOptions) => SpawnedProcess
  readonly ready: Promise<void>
  readonly exited: Promise<void>
  readonly started: Promise<void>
  prepare(): Promise<void>
  release(): void
  assertReady(): void
  activate(): void
  cancel(): void
}
