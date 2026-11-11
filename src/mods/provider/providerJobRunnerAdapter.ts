/**
 * Contract: the job runner the status view's actions reach (F-27). Answers
 * as soon as the scheduler took or refused the run, not when the run ends.
 * `busy` covers a run already queued or going, `cooldown` a manual run asked
 * for too soon after the last, `unavailable` every other refusal. Never
 * rejects. `settled` is called once after an accepted run ended.
 */
import type { ProviderJobScheduler } from './providerJobScheduler'
import type { ProviderJobRunner } from './providerJobSeam'

export function providerJobRunnerOf(
  jobs: Pick<ProviderJobScheduler, 'runNow' | 'states'>,
  settled?: (providerId: string) => void,
): ProviderJobRunner {
  const busy = (providerId: string, jobName: string): boolean =>
    jobs.states(providerId).some(state => state.id === jobName && state.busy)

  return async (providerId, jobName) => {
    if (busy(providerId, jobName)) return 'busy'
    const run = jobs.runNow(providerId, jobName)
    if (busy(providerId, jobName)) {
      void run.then(
        () => settled?.(providerId),
        () => undefined,
      )
      return 'started'
    }
    const result = await run
    if (result.status !== 'refused') return 'started'
    if (result.reason === 'busy') return 'busy'
    if (result.reason === 'too_soon') return 'cooldown'
    return 'unavailable'
  }
}
