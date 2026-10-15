/**
 * `provider.models`, `provider.verify` and `provider.usage` as the adapter's
 * `ProviderCodeListing`, shaped for the existing listing / verify / usage paths,
 * which decide when each is called. Type-only import of the runtime.
 */

import type { BrowserBridgeTransport } from '../../browser/bridge/browserBridgeProtocol'
import type {
  ProviderCodeListing,
  ProviderVerifyResult,
} from '../../config/nexusModelConfig/providerDefinition'
import type { PlanUsageSnapshot } from '../../models/usage/planUsage'
import { parseUsageAnswer, parseVerifyAnswer } from './providerAnswers'
import { PROVIDER_EVENTS, type ProviderEventName } from './providerEvents'
import { parseModelsAnswer } from './providerModelsAnswer'
import type { ProviderModRuntime } from './ProviderModRuntime'

/** What a cold start (compile, spawn) may take on top of a hook's own budget
 *  before the whole call is abandoned. */
export const PROVIDER_CODE_COLD_START_MS = 60_000

export type ProviderCodeCallDeps = {
  /** The one runtime, once some provider plugin made it. */
  runtime: () => ProviderModRuntime | undefined
  /** The provider has credentials (or the person chose anonymous). */
  connected: (providerId: string) => boolean
  /** The provider's settings values for `e.settings`. Absent or failing: `{}`. */
  settings?: (providerId: string) => Promise<Record<string, unknown>> | Record<string, unknown>
  /** The provider's base URL, against which a row's `wire.baseUrl` is held. */
  baseUrl: (providerId: string) => string | undefined
  report: (line: string) => void
  coldStartMs?: number
}

/** What `ProviderModHostOptions` takes and the adapter definition carries. */
export type ProviderCodeCalls = {
  listModels: ProviderCodeListing['list']
  verify: NonNullable<ProviderCodeListing['verify']>
  usage: {
    reports(providerId: string): boolean
    fetch(
      transport: BrowserBridgeTransport,
      providerId: string,
      options: { signal?: AbortSignal; now?: number },
    ): Promise<PlanUsageSnapshot | undefined>
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const isAbort = (error: unknown): boolean => error instanceof Error && error.name === 'AbortError'
const isUnavailable = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ProviderModUnavailableError'

export function providerCodeCalls(deps: ProviderCodeCallDeps): ProviderCodeCalls {
  const coldStartMs = deps.coldStartMs ?? PROVIDER_CODE_COLD_START_MS

  const runtimeOf = (): ProviderModRuntime => {
    const runtime = deps.runtime()
    if (!runtime) throw new Error('the provider module runtime is not running')
    return runtime
  }

  /** The caller's signal, and an overall bound: a hook's own budget plus a cold start. */
  const bounded = (event: ProviderEventName, signal: AbortSignal | undefined): AbortSignal => {
    const timeout = AbortSignal.timeout(coldStartMs + PROVIDER_EVENTS[event].budgetMs)
    return signal ? AbortSignal.any([signal, timeout]) : timeout
  }

  const settingsOf = async (providerId: string): Promise<Record<string, unknown>> => {
    try {
      return (await deps.settings?.(providerId)) ?? {}
    } catch (error) {
      deps.report(`${providerId}: its settings could not be read for the provider module: ${errorText(error)}`)
      return {}
    }
  }

  /** `e.baseUrl`: the base URL in force (the stored override, else the manifest's default). */
  const baseUrlOf = (providerId: string): { baseUrl?: string } => {
    const baseUrl = deps.baseUrl(providerId)
    return baseUrl ? { baseUrl } : {}
  }

  const listModels: ProviderCodeCalls['listModels'] = async (_transport, providerId, options) => {
    const runtime = runtimeOf()
    const signal = bounded('provider.models', options.signal)
    let outcome
    try {
      outcome = await runtime.call<unknown>(
        providerId,
        'provider.models',
        { settings: await settingsOf(providerId), connected: deps.connected(providerId), ...baseUrlOf(providerId) },
        { signal },
      )
    } catch (error) {
      if (isAbort(error)) throw new Error('provider.models did not finish in time')
      throw error
    }
    if (!outcome.raised) {
      throw new Error('the provider module does not list models (it has no provider.models hook)')
    }
    return parseModelsAnswer(providerId, outcome.value, deps.baseUrl(providerId)).models
  }

  const verify: ProviderCodeCalls['verify'] = async (_transport, providerId, options) => {
    const { core } = options
    const runtime = deps.runtime()
    if (!runtime) return core()
    let coreAnswer: { value: ProviderVerifyResult } | undefined
    const viaCore = async (): Promise<ProviderVerifyResult> => {
      const value = await core()
      coreAnswer = { value }
      return value
    }
    try {
      const outcome = await runtime.call<ProviderVerifyResult>(
        providerId,
        'provider.verify',
        { settings: await settingsOf(providerId), ...baseUrlOf(providerId) },
        { signal: bounded('provider.verify', options.signal), core: viaCore },
      )
      // No hook, or one that did not answer: the core probe.
      if (!outcome.raised) return await core()
      // The core's own answer, relayed: as the core gave it.
      if (coreAnswer && JSON.stringify(outcome.value) === JSON.stringify(coreAnswer.value)) return coreAnswer.value
      const answer = parseVerifyAnswer(outcome.value)
      if (answer) return answer
      if (coreAnswer) {
        deps.report(`${providerId}: provider.verify answered something that is not a verify result; the core check's answer stands`)
        return coreAnswer.value
      }
      deps.report(`${providerId}: provider.verify answered something that is not a verify result; the core check ran instead`)
      return await core()
    } catch (error) {
      // A module that cannot serve is checked by the core probe like one with
      // no hook; only the person's own time running out is a verdict here.
      if (isUnavailable(error)) return await core()
      if (isAbort(error)) {
        return { ok: false, code: 'network_timeout', message: 'provider.verify did not finish in time' }
      }
      return { ok: false, code: 'system_unexpected', message: errorText(error) }
    }
  }

  const usage: ProviderCodeCalls['usage'] = {
    // Unknown until the module has loaded once; then exact.
    reports: providerId => {
      const runtime = deps.runtime()
      return runtime !== undefined && runtime.hasHook(providerId, 'provider.usage') !== false
    },
    fetch: async (_transport, providerId, options) => {
      const runtime = runtimeOf()
      let outcome
      try {
        outcome = await runtime.call<unknown>(
          providerId,
          'provider.usage',
          { settings: await settingsOf(providerId), ...baseUrlOf(providerId) },
          { signal: bounded('provider.usage', options.signal) },
        )
      } catch (error) {
        if (isAbort(error)) throw new Error('provider.usage did not finish in time')
        throw error
      }
      // No hook = no usage shown.
      if (!outcome.raised) return undefined
      return parseUsageAnswer(outcome.value)
    },
  }

  return { listModels, verify, usage }
}
