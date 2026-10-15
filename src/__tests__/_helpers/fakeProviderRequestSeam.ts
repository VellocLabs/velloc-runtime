/**
 * An in-process provider request seam for tests: each hook answers from a
 * script (a value, or a function of the event) and records the events it was
 * raised with. A hook the script leaves out is absent, so it is not raised.
 */
import type {
  ProviderRequestAnswer,
  ProviderRequestEvent,
  ProviderRequestSeam,
  ProviderRetryAnswer,
  ProviderRetryEvent,
  ProviderSignAnswer,
  ProviderSignEvent,
} from '../../models/drivers/providerRequestSeam'

type Answer<E, A> = A | undefined | ((e: E) => A | undefined | Promise<A | undefined>)

export type FakeProviderRequestSeamScript = {
  request?: Answer<ProviderRequestEvent, ProviderRequestAnswer>
  sign?: Answer<ProviderSignEvent, ProviderSignAnswer>
  retry?: Answer<ProviderRetryEvent, ProviderRetryAnswer>
  whenReady?: (signal: AbortSignal) => Promise<void>
  budgetMs?: number
  requestNeeds?: ProviderRequestSeam['requestNeeds']
  signNeeds?: ProviderRequestSeam['signNeeds']
}

export type FakeProviderRequestSeam = {
  seam: ProviderRequestSeam
  calls: {
    request: ProviderRequestEvent[]
    sign: ProviderSignEvent[]
    retry: ProviderRetryEvent[]
  }
}

function answer<E, A>(script: Answer<E, A>, e: E): A | undefined | Promise<A | undefined> {
  return typeof script === 'function' ? (script as (e: E) => A | undefined)(e) : script
}

export function fakeProviderRequestSeam(script: FakeProviderRequestSeamScript): FakeProviderRequestSeam {
  const calls: FakeProviderRequestSeam['calls'] = { request: [], sign: [], retry: [] }
  const seam: ProviderRequestSeam = {
    ...(script.budgetMs !== undefined ? { budgetMs: script.budgetMs } : {}),
    ...(script.whenReady ? { whenReady: script.whenReady } : {}),
    ...(script.requestNeeds ? { requestNeeds: script.requestNeeds } : {}),
    ...(script.signNeeds ? { signNeeds: script.signNeeds } : {}),
    ...('request' in script
      ? {
          request: (e: ProviderRequestEvent) => {
            calls.request.push(e)
            return answer(script.request, e)
          },
        }
      : {}),
    ...('sign' in script
      ? {
          sign: (e: ProviderSignEvent) => {
            calls.sign.push(e)
            return answer(script.sign, e)
          },
        }
      : {}),
    ...('retry' in script
      ? {
          retry: (e: ProviderRetryEvent) => {
            calls.retry.push(e)
            return answer(script.retry, e)
          },
        }
      : {}),
  }
  return { seam, calls }
}
