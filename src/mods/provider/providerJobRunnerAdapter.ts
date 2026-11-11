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
  jobs: Pick<ProviderJobScheduler, 'requestRun'>,
  settled?: (providerId: string) => void,
): ProviderJobRunner {
  return async (providerId, jobName) => {
    const request = jobs.requestRun(providerId, jobName)
    if (request.status === 'accepted') {
      void request.done.then(
        () => settled?.(providerId),
        () => undefined,
      )
      return 'started'
    }
    if (request.reason === 'busy') return 'busy'
    if (request.reason === 'too_soon') return 'cooldown'
    return 'unavailable'
  }
}
