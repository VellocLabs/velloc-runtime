/**
 * The host half of a `provider.login` hook's `interact` handle. Security: the module
 * cannot open anything itself; `openUrl` publishes a step and the PAGE opens it on
 * the person's click (http / https only, also checked here). A call naming another
 * module's provider is refused; all reject on cancel or timeout.
 */
import type { NexusProviderConfig } from '../../../settings/settingsTypes'
import { identityOfHost } from '../identitySites'
import type { ProviderNounCall, ProviderNounTable } from '../ProviderModRuntime'
import type { WebProfile, WebProfiles } from '../webProfiles'
import type { ProviderCredentials } from './providerCredentials'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * `list()` as one caller sees it: every profile and record, and on each
 * account record the caller's providers signed in through it. Security:
 * `owned` are the caller's own provider ids; no other plugin's are named.
 */
function listedFor(
  rows: readonly WebProfile[],
  owned: readonly string[],
  storedConfigOf: (providerId: string) => NexusProviderConfig | undefined,
): unknown[] {
  const through = owned.flatMap(providerId => {
    const at = storedConfigOf(providerId)?.webProfile
    return at ? [{ providerId, ...at }] : []
  })
  return rows.map(row => ({
    ...row,
    accounts: row.accounts.map(account => {
      const identity = identityOfHost(account.site)
      return {
        ...account,
        providers: through.filter(each => each.id === row.id && each.site === account.site).map(each => each.providerId),
        ...(identity !== undefined ? { identity } : {}),
      }
    }),
  }))
}

/**
 * `$.provider.webProfiles.*`: every plugin reads all profiles; a login record
 * is the caller's own. Security: no noun writes or removes an account record.
 */
export function createWebProfileNouns(
  profiles: () => WebProfiles,
  storedConfigOf: (providerId: string) => NexusProviderConfig | undefined,
): ProviderNounTable {
  return Object.freeze({
    webProfilesList: async (call: ProviderNounCall) => listedFor(await profiles().list(), call.providers, storedConfigOf),
    webProfilesSetLogin: async (call: ProviderNounCall) => profiles().setLogin(call.plugin, call.args[0], call.args[1]),
    webProfilesRemoveLogin: async (call: ProviderNounCall) => profiles().removeLogin(call.plugin, call.args[0], call.args[1]),
  })
}

export function createLoginNouns(
  service: Pick<ProviderCredentials, 'interact' | 'moduleFailed' | 'openWindow'>,
): ProviderNounTable {
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
    // The window opens on a host the manifest allows; the module gets the captured URL only.
    interactOpenWindow: (call: ProviderNounCall) => service.openWindow(call.args[0], call.providers, call.args[1]),
    interactProgress: (call: ProviderNounCall) =>
      service.interact(call.args[0], call.providers, { kind: 'progress', text: call.args[1] }),
    interactFail: (call: ProviderNounCall) => {
      service.moduleFailed(call.args[0] as string, call.providers, call.args[1])
      return undefined
    },
  })
}
