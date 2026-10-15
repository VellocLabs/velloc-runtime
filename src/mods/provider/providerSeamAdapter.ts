/**
 * Security: maps the request seam's `request` / `sign` / `retry` onto a provider
 * module's events. Hooks the module is known not to have are not defined. Budgets
 * count from `whenReady`. `request` / `sign` that cannot be served or are unanswered
 * fail closed (`ProviderHookError`, not sent); `retry` never fails the request.
 */
import {
  ProviderHookError,
  type ProviderHookName,
  type ProviderRequestAnswer,
  type ProviderRequestEvent,
  type ProviderRequestSeam,
  type ProviderSeamCredentials,
  type ProviderRetryAnswer,
  type ProviderRetryEvent,
  type ProviderSignAnswer,
  type ProviderSignEvent,
} from '../../models/drivers/providerRequestSeam'
import {
  ProviderHookUnansweredError,
  ProviderModUnavailableError,
  type ProviderCallOptions,
  type ProviderCallOutcome,
} from './ProviderModRuntime'
import type { IdHook } from './ids/idMapper'
import type { ProviderEventName } from './providerEvents'
import { checkProviderNeeds } from './providerRequestNeeds'

/** What the adapter uses of the runtime (`ProviderModRuntime` satisfies it). */
export interface ProviderSeamRuntime {
  call<R = unknown>(
    providerId: string,
    event: ProviderEventName,
    e?: Readonly<Record<string, unknown>>,
    options?: ProviderCallOptions<R>,
  ): Promise<ProviderCallOutcome<R>>
  hasHook(providerId: string, event: ProviderEventName): boolean | undefined
  /** Loads the module owning `providerId`; resolves once it can answer. */
  whenLoaded(providerId: string, signal?: AbortSignal): Promise<void>
}

const EVENT_OF: Record<Exclude<ProviderHookName, 'ids'>, ProviderEventName> = {
  request: 'provider.request',
  sign: 'provider.sign',
  retry: 'provider.retry',
}

/**
 * The id mapper's `provider.ids` call (ids/idMapper.ts): one call per request
 * for the ids not yet mapped, `{ ids, context }` -> `string[]`. The runtime
 * holds it to its 1 s budget; a module with no such hook, one that throws or
 * overruns, rejects here - and the mapper (so the request) fails closed.
 */
export function createIdsHook(runtime: Pick<ProviderSeamRuntime, 'call'>, providerId: string): IdHook {
  return async (ids, context, signal) => {
    const outcome = await runtime.call<unknown>(
      providerId,
      'provider.ids',
      { ids, context },
      signal ? { signal } : {},
    )
    if (!outcome.raised) throw new Error('an id rule says "hook", but the module has no provider.ids hook')
    return outcome.value
  }
}

/**
 * The seam for `providerId`'s module. `needs` is the provider's descriptor
 * declaration (`requestNeeds`, `signNeeds`); it is checked here again and a
 * bad one throws, so a seam never runs on a declaration nobody validated.
 */
export function createProviderSeam(
  runtime: ProviderSeamRuntime,
  providerId: string,
  needs: { requestNeeds?: unknown; signNeeds?: unknown } = {},
  /** A provider that signs in (PM-7): the token's refresh, kept apart from the
   *  hooks above because it is single-flight across requests. Read through the
   *  seam only while the module is not known to lack a `provider.refresh`. */
  credentials?: ProviderSeamCredentials,
): ProviderRequestSeam {
  const checked = checkProviderNeeds(needs)
  if (!checked.ok) throw new TypeError(`provider ${providerId}: ${checked.error}`)

  /** Raise `hook`'s event; `undefined` when the module has no hook on it. */
  async function raise<R>(
    hook: Exclude<ProviderHookName, 'ids'>,
    e: Readonly<Record<string, unknown>>,
    signal: AbortSignal | undefined,
    options: Pick<ProviderCallOptions<R>, 'core'> = {},
  ): Promise<R | undefined> {
    try {
      const outcome = await runtime.call<R>(providerId, EVENT_OF[hook], e, {
        ...(signal ? { signal } : {}),
        ...options,
      })
      return outcome.raised ? outcome.value : undefined
    } catch (error) {
      if (error instanceof ProviderModUnavailableError || error instanceof ProviderHookUnansweredError) {
        throw new ProviderHookError(hook, providerId, error.message)
      }
      throw error
    }
  }

  const request = (e: ProviderRequestEvent, signal?: AbortSignal): Promise<ProviderRequestAnswer | undefined> =>
    raise<ProviderRequestAnswer>('request', e, signal)
  const sign = (e: ProviderSignEvent, signal?: AbortSignal): Promise<ProviderSignAnswer | undefined> =>
    raise<ProviderSignAnswer>('sign', e, signal)
  // A retry nobody answers is not an error: the response's error goes on.
  const retry = (e: ProviderRetryEvent, signal?: AbortSignal): Promise<ProviderRetryAnswer | undefined> =>
    raise<ProviderRetryAnswer | undefined>('retry', e, signal, { core: () => undefined })

  // The stream host reads each hook when it is about to raise it, so the
  // answer of `hasHook` is looked up then: a hook that turned out absent once
  // the module loaded is gone for the rest of the stream.
  const seam: ProviderRequestSeam = {
    whenReady: signal => runtime.whenLoaded(providerId, signal),
    get request() {
      return runtime.hasHook(providerId, 'provider.request') === false ? undefined : request
    },
    get sign() {
      return runtime.hasHook(providerId, 'provider.sign') === false ? undefined : sign
    },
    get retry() {
      return runtime.hasHook(providerId, 'provider.retry') === false ? undefined : retry
    },
    get credentials() {
      return credentials && runtime.hasHook(providerId, 'provider.refresh') !== false ? credentials : undefined
    },
    requestNeeds: checked.needs.requestNeeds,
    ...(checked.needs.signNeeds ? { signNeeds: checked.needs.signNeeds } : {}),
  }
  return seam
}
