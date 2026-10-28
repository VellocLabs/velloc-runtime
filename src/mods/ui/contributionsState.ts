/**
 * The published half of the UI contributions (F-25): the last state and who
 * resolves a topbar press. Kept apart from `contributionsHost.ts` so the hub
 * reads it without loading the scan's code; the host writes here.
 */

import {
  EMPTY_MOD_CONTRIBUTIONS,
  type ModContributionsState,
} from '../../browser/runtimeProtocol/modContributions'

/** What a topbar item runs, or why it cannot. */
export type TopbarResolution =
  | { kind: 'run'; plugin: string; command: string; args?: string }
  | { kind: 'waiting' }
  | { kind: 'unknown' }

let state: ModContributionsState = EMPTY_MOD_CONTRIBUTIONS
const listeners = new Set<(next: ModContributionsState) => void>()
let resolver: ((id: string) => TopbarResolution) | undefined
let syncGate: (() => Promise<void>) | undefined
let gateWaiters: Array<() => void> = []

export function modContributionsState(): ModContributionsState {
  return state
}

export function onModContributionsChanged(listener: (next: ModContributionsState) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function publishModContributions(next: ModContributionsState): void {
  state = next
  for (const listener of [...listeners]) listener(next)
}

export function setTopbarResolver(next: ((id: string) => TopbarResolution) | undefined): void {
  resolver = next
}

/** The host sets it when configured: settles once the first scan is judged. */
export function setModContributionsSyncGate(gate: (() => Promise<void>) | undefined): void {
  syncGate = gate
  if (!gate) return
  const waiters = gateWaiters
  gateWaiters = []
  for (const waiter of waiters) waiter()
}

/**
 * Settles once the first plugin scan is taken and judged, so a reader does not
 * take the pre-scan empty state for "no plugin offers anything". Waits for the
 * host to be configured first: a page that subscribes before the scan starts
 * gets its first state when the scan has spoken, not before.
 */
export async function whenModContributionsSynced(): Promise<void> {
  if (!syncGate) await new Promise<void>(resolve => gateWaiters.push(resolve))
  await syncGate!()
}

export function resolveTopbarItem(id: string): TopbarResolution {
  return resolver?.(id) ?? { kind: 'unknown' }
}

/** Tests: back to nothing published. */
export function resetModContributionsState(): void {
  state = EMPTY_MOD_CONTRIBUTIONS
  listeners.clear()
  resolver = undefined
  syncGate = undefined
  gateWaiters = []
}
