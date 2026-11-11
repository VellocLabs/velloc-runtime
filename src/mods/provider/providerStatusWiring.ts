/**
 * Feeds the status table from the provider mod host (F-27): the registered
 * providers that declare a view, and the plugin store their values are read
 * from. A provider that registers or leaves is re-read at once.
 */
import { getProviderModHost, onProviderModRegistered } from './providerModHost'
import { noteProviderStatusSubjectChange, setProviderStatusSources } from './providerStatusService'

export function wireProviderStatus(read: (plugin: string, key: string) => Promise<unknown>): void {
  setProviderStatusSources({
    subjects: () =>
      getProviderModHost()
        .registered()
        .flatMap(entry =>
          entry.manifest.status ? [{ providerId: entry.providerId, plugin: entry.plugin, view: entry.manifest.status }] : [],
        ),
    read,
  })
  onProviderModRegistered(registration => {
    if (!registration.manifest.status) return undefined
    noteProviderStatusSubjectChange(registration.providerId)
    // Runs once the provider is gone from the host's list.
    return () => noteProviderStatusSubjectChange(registration.providerId)
  })
}
