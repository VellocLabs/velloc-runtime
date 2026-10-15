/**
 * The host half of a `provider.login` hook's `interact` handle. Security: the module
 * cannot open anything itself; `openUrl` publishes a step and the PAGE opens it on
 * the person's click (http / https only, also checked here). A call naming another
 * module's provider is refused; all reject on cancel or timeout.
 */
import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'
import type { ProviderCredentials } from './providerCredentials'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function createLoginNouns(service: Pick<ProviderCredentials, 'interact' | 'moduleFailed'>): ProviderNounTable {
  const about = async <T>(call: ProviderNounCall, noun: string, run: (given: Record<string, unknown>) => Promise<T>) => {
    if (!isRecord(call.args[1])) throw new TypeError(`interact.${noun} takes an object`)
    return run(call.args[1])
  }
  return Object.freeze({
    interactOpenUrl: (call: ProviderNounCall) =>
      service.interact(call.args[0], call.providers, { kind: 'openUrl', url: call.args[1] }),
    interactShowCode: (call: ProviderNounCall) =>
      about(call, 'showCode', given =>
        service.interact(call.args[0], call.providers, { kind: 'showCode', code: given.code, url: given.url }),
      ),
    interactPrompt: (call: ProviderNounCall) =>
      about(call, 'prompt', given =>
        service.interact(call.args[0], call.providers, { kind: 'prompt', label: given.label, secret: given.secret }),
      ),
    interactChoose: (call: ProviderNounCall) =>
      about(call, 'choose', given =>
        service.interact(call.args[0], call.providers, { kind: 'choose', label: given.label, options: given.options }),
      ),
    interactProgress: (call: ProviderNounCall) =>
      service.interact(call.args[0], call.providers, { kind: 'progress', text: call.args[1] }),
    interactFail: (call: ProviderNounCall) => {
      service.moduleFailed(call.args[0] as string, call.providers, call.args[1])
      return undefined
    },
  })
}
