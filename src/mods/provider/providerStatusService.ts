/**
 * Contract: the runtime's table of provider status views (F-27), one shaped
 * entry per registered provider that declares `status`. An entry is read
 * again when the plugin's store key changes, when a client asks and when a
 * client subscribes. The runtime hub serves the table as the
 * `providers/status` topic and the `providerStatus.*` actions. A failed read
 * never rejects; the entry records it.
 */
import { runProviderJobNow } from './providerJobSeam'
import type { ProviderStatusView } from './providerStatusManifest'
import type {
  ProviderJobRunOutcome,
  ProviderStatusEntry,
  ProviderStatusState,
} from './providerStatusState'
import { shapeProviderStatus } from './providerStatusView'

/** A registered provider that declares a status view. */
export type ProviderStatusSubject = { providerId: string; plugin: string; view: ProviderStatusView }

export type ProviderStatusSources = {
  subjects: () => ProviderStatusSubject[]
  /** The value under `key` in the plugin's `$.store`. */
  read: (plugin: string, key: string) => Promise<unknown>
  now?: () => number
}

const entries = new Map<string, ProviderStatusEntry>()
const running = new Map<string, { task: Promise<ProviderStatusEntry | undefined>; again: boolean }>()
let sources: ProviderStatusSources | undefined
let publish: ((state: ProviderStatusState) => void) | undefined

/** Where the views and their values come from; set by the provider mod wiring. */
export function setProviderStatusSources(next: ProviderStatusSources | undefined): void {
  sources = next
}

/** The hub's publisher for the `providers/status` topic. */
export function setProviderStatusPublisher(next: ((state: ProviderStatusState) => void) | undefined): void {
  publish = next
}

export function providerStatusState(): ProviderStatusState {
  return Object.fromEntries(entries)
}

function subjectOf(providerId: string): ProviderStatusSubject | undefined {
  return sources?.subjects().find(subject => subject.providerId === providerId)
}

function forget(providerId: string): void {
  if (entries.delete(providerId)) publish?.(providerStatusState())
}

async function readOnce(providerId: string): Promise<ProviderStatusEntry | undefined> {
  const subject = subjectOf(providerId)
  if (!subject || !sources) {
    forget(providerId)
    return undefined
  }
  const readAt = (sources.now ?? Date.now)()
  let entry: ProviderStatusEntry
  try {
    entry = shapeProviderStatus(subject.view, await sources.read(subject.plugin, subject.view.source.store), readAt)
  } catch (error) {
    const { empty: _empty, ...blank } = shapeProviderStatus(subject.view, undefined, readAt)
    entry = { ...blank, error: (error instanceof Error ? error.message : String(error)).slice(0, 300) }
  }
  // The provider may have gone while the store was read.
  if (!subjectOf(providerId)) {
    forget(providerId)
    return undefined
  }
  entries.set(providerId, entry)
  publish?.(providerStatusState())
  return entry
}

/**
 * Read one provider's view again and publish the table. `undefined` for a
 * provider with no view (its entry, if any, is dropped). A request made while
 * a read is under way is answered by one more read after it.
 */
export function refreshProviderStatus(providerId: string): Promise<ProviderStatusEntry | undefined> {
  const current = running.get(providerId)
  if (current) {
    current.again = true
    return current.task
  }
  const slot: { task: Promise<ProviderStatusEntry | undefined>; again: boolean } = {
    again: false,
    task: Promise.resolve(undefined),
  }
  slot.task = (async () => {
    try {
      let entry = await readOnce(providerId)
      while (slot.again) {
        slot.again = false
        entry = await readOnce(providerId)
      }
      return entry
    } finally {
      running.delete(providerId)
    }
  })()
  running.set(providerId, slot)
  return slot.task
}

/** Read every declared view, and drop the entries of providers that left. */
export async function refreshAllProviderStatus(): Promise<ProviderStatusState> {
  const ids = new Set((sources?.subjects() ?? []).map(subject => subject.providerId))
  for (const known of [...entries.keys()]) if (!ids.has(known)) forget(known)
  await Promise.all([...ids].map(id => refreshProviderStatus(id)))
  return providerStatusState()
}

/** A plugin's store wrote or deleted `key`: re-read the views fed by it. */
export function noteProviderStoreChange(plugin: string, key: string): void {
  for (const subject of sources?.subjects() ?? []) {
    if (subject.plugin === plugin && subject.view.source.store === key) void refreshProviderStatus(subject.providerId)
  }
}

/** A provider was registered or removed. */
export function noteProviderStatusSubjectChange(providerId: string): void {
  void refreshProviderStatus(providerId)
}

export class ProviderStatusActionError extends Error {}

/**
 * Run the job behind one of the view's buttons. Only a job the provider's
 * view offers as an action is passed on; anything else is refused.
 */
export async function runProviderStatusJob(providerId: string, job: string): Promise<ProviderJobRunOutcome> {
  const subject = subjectOf(providerId)
  if (!subject) throw new ProviderStatusActionError(`provider '${providerId}' has no status view`)
  if (!(subject.view.actions ?? []).some(action => action.job === job)) {
    throw new ProviderStatusActionError(`provider '${providerId}' offers no action for the job '${job}'`)
  }
  return runProviderJobNow(providerId, job)
}

/** Tests only. */
export function resetProviderStatusForTests(): void {
  entries.clear()
  running.clear()
  sources = undefined
  publish = undefined
}
