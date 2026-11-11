/**
 * Contract: the one way anything outside the jobs runtime asks for a
 * provider's declared job to run now (F-27). `runProviderJobNow` never
 * rejects. With no runner installed it answers `unavailable` and nothing runs.
 * The runner owns the rules of a manual run (the job is declared, the provider
 * set up, one run at a time, a minimum gap) and reports them as an outcome.
 */
import type { ProviderJobRunOutcome } from './providerStatusState'

export type ProviderJobRunner = (providerId: string, jobName: string) => Promise<ProviderJobRunOutcome>

let runner: ProviderJobRunner | undefined

/** Install (or, with `undefined`, remove) the realm's job runner. */
export function setProviderJobRunner(next: ProviderJobRunner | undefined): void {
  runner = next
}

export async function runProviderJobNow(providerId: string, jobName: string): Promise<ProviderJobRunOutcome> {
  if (!runner) return 'unavailable'
  try {
    return await runner(providerId, jobName)
  } catch {
    return 'unavailable'
  }
}
