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

export function resolveTopbarItem(id: string): TopbarResolution {
  return resolver?.(id) ?? { kind: 'unknown' }
}

/** Tests: back to nothing published. */
export function resetModContributionsState(): void {
  state = EMPTY_MOD_CONTRIBUTIONS
  listeners.clear()
  resolver = undefined
}
